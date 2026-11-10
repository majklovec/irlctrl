/*
 * ModemManager + NetworkManager integration of the modems module: enumerate
 * modems, resolve their network interfaces, run control actions (enable /
 * disable / reset / connect / disconnect), and keep each modem on the network.
 *
 * Connectivity follows the reference implementation (belaUI.js): a persistent
 * NetworkManager `type gsm` autoconnect connection per (device, SIM) dials on
 * boot and a periodic loop reactivates it whenever it drops and the modem is
 * registered. `mmcli --simple-connect` is deliberately NOT used — it fights
 * NetworkManager and cannot auto-reconnect.
 */
import { errorMessage } from "../../../shared/util";
import type { ModuleCore } from "../../backend/module_core";
import type { ModemInfo, ModemSource } from "./types";

let core: ModuleCore;

/** Bind the process services used by ModemManager / NetworkManager. */
export function bindModemManager(c: ModuleCore): void {
    core = c;
}

const mmcli = (...args: string[]) => core.run("mmcli", args, true);
const nmcli = (...args: string[]) => core.run("nmcli", args, true);

/** How often the auto-dial loop re-checks the modems (ms). */
const AUTO_DIAL_MS = 5000;
/** How long `nmcli conn up` may block before we give up on one modem (s). */
const ACTIVATE_TIMEOUT_S = 60;

/** Parse `mmcli --output-keyvalue` output (`key: value` lines) into a map. */
function parseKeyvalue(text: string): Record<string, string> {
    const kv: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        if (key) kv[key] = line.slice(idx + 1).trim();
    }
    return kv;
}

/** First non-empty value among the candidate (lowercase) keys of a keyvalue map. */
function pickField(
    kv: Record<string, string>,
    ...candidates: string[]
): string | undefined {
    for (const candidate of candidates) {
        const value = kv[candidate];
        if (value) return value;
    }
    return undefined;
}

async function modemDetails(
    index: number,
    label: string,
): Promise<ModemInfo> {
    // `--output-keyvalue` emits the stable ModemManager D-Bus property keys
    // (modem.generic.state, modem.3gpp.imei, …) across MM versions — far more
    // reliable than the human table, whose layout changed in MM 1.16+.
    const detail = parseKeyvalue(
        await mmcli("-m", String(index), "--output-keyvalue"),
    );
    const info: ModemInfo = {
        index,
        path: `/org/freedesktop/ModemManager1/Modem/${index}`,
        state: "unknown",
        powerState: "unknown",
    };
    const state = pickField(detail, "modem.generic.state");
    if (state) info.state = state;
    const power = pickField(detail, "modem.generic.power-state");
    if (power) info.powerState = power;
    info.model = pickField(detail, "modem.generic.model") ?? label;
    info.manufacturer = pickField(detail, "modem.generic.manufacturer");
    info.imei = pickField(
        detail,
        "modem.3gpp.imei",
        "modem.generic.equipment-identifier",
    );
    info.primaryPort = pickField(detail, "modem.generic.primary-port");
    info.deviceId = pickField(detail, "modem.generic.device-identifier");
    info.simPath = pickField(detail, "modem.generic.sim");
    info.operatorName = pickField(detail, "modem.3gpp.operator-name");
    info.registrationState = pickField(detail, "modem.3gpp.registration-state");
    info.accessTech = pickField(detail, "modem.generic.access-technologies.value[1]");
    const signal = pickField(detail, "modem.generic.signal-quality.value")?.match(
        /(\d+)/,
    );
    if (signal) info.signalQuality = Number(signal[1]);
    return info;
}

async function scanModems(): Promise<ModemInfo[]> {
    const list = [...(await mmcli("-L")).matchAll(/Modem\/(\d+)\s+(.*)$/gm)];
    return Promise.all(
        list.map(([, index, label]) =>
            modemDetails(Number(index), label.trim()),
        ),
    );
}

let scanning: Promise<ModemInfo[]> | null = null;

/** Enumerate modems; concurrent callers share one mmcli scan. */
export function detectModems(): Promise<ModemInfo[]> {
    scanning ??= scanModems().finally(() => {
        scanning = null;
    });
    return scanning;
}

async function modemNetworkIface(modem: ModemInfo): Promise<string | null> {
    for (const [, bearer] of (
        await mmcli("-m", String(modem.index), "-b")
    ).matchAll(/Bearer\/(\d+)/g)) {
        const iface = (await mmcli("-b", bearer)).match(/interface:\s*(\S+)/);
        if (iface) return iface[1];
    }
    const wwan = (
        await core.run("ip", ["-o", "-4", "addr", "show"], true)
    ).match(/wwan\d+/g);
    if (!wwan) return null;
    return wwan.find((name) => name === `wwan${modem.index}`) ?? wwan[0];
}

export const modemSource: ModemSource = {
    detect: detectModems,
    modemIface: modemNetworkIface,
};

// ------------------------------------------------------------------------
// NetworkManager gsm connections (ported from belaUI.js)
// ------------------------------------------------------------------------

interface GsmConn {
    uuid: string;
    state: string;
    deviceId?: string;
    simId?: string; // SIM ICCID
    operatorId?: string;
    apn?: string;
}

/** All active gsm connections from NetworkManager, keyed fields included. */
async function gsmConns(): Promise<GsmConn[]> {
    const rows = (
        await nmcli("-t", "-f", "uuid,type,state", "connection", "show")
    ).split("\n");
    const conns: GsmConn[] = [];
    for (const row of rows) {
        if (!row) continue;
        const [uuid, type, state] = row.split(":");
        if (type !== "gsm") continue;
        // gsm.* are not valid `connection show -f` fields on older nmcli;
        // `--get-values` retrieves arbitrary connection properties, one per
        // line in terse mode (belaUI.js uses the same form).
        const fields = (
            await nmcli(
                "-t",
                "-e",
                "no",
                "--get-values",
                "gsm.device-id,gsm.sim-id,gsm.sim-operator-id,gsm.apn",
                "connection",
                "show",
                uuid,
            )
        ).split("\n");
        conns.push({
            uuid,
            state: state ?? "",
            deviceId: fields[0] || undefined,
            simId: fields[1] || undefined,
            operatorId: fields[2] || undefined,
            apn: fields[3] || undefined,
        });
    }
    return conns;
}

/** The gsm connection (if any) already bound to this modem + SIM. */
async function findGsmConn(
    deviceId: string,
    iccid: string,
): Promise<GsmConn | undefined> {
    return (await gsmConns()).find(
        (c) => c.deviceId === deviceId && c.simId === iccid,
    );
}

/** ICCID + operator code of the modem's SIM, from the SIM object on D-Bus. */
async function simFields(
    simPath: string,
): Promise<{ iccid?: string; operatorId?: string }> {
    const m = simPath.match(/Sim\/(\d+)\s*$/);
    if (!m) return {};
    // `-i` is `--with-sim` (`-s` is `--with-sms` — don't mix them up).
    const kv = parseKeyvalue(
        await mmcli("-i", m[1], "--output-keyvalue"),
    );
    return {
        iccid: pickField(kv, "sim.properties.iccid"),
        operatorId: pickField(
            kv,
            "sim.properties.operator-code",
            "sim.properties.operator-name",
        ),
    };
}

/**
 * Find the modem's gsm connection, creating it on first sight (mirroring
 * belaUI.js `modemGetConfig`). Returns the connection UUID to bring up, or
 * null when there is no SIM to dial with.
 */
async function ensureGsmConn(modem: ModemInfo): Promise<string | null> {
    const deviceId = modem.deviceId;
    if (!deviceId || !modem.simPath) return null;
    const { iccid, operatorId } = await simFields(modem.simPath);
    if (!iccid) return null;

    const conns = await gsmConns();
    const existing = conns.find(
        (c) => c.deviceId === deviceId && c.simId === iccid,
    );
    if (existing) {
        // Reuse the profile; give it a default APN if it had none.
        if (!existing.apn)
            await nmcli("con", "modify", existing.uuid, "gsm.apn", "internet");
        return existing.uuid;
    }

    // No profile for this (device, SIM): create an autoconnect gsm connection,
    // copying the APN from a same-operator profile when one exists.
    const donor = conns.find(
        (c) => operatorId && c.operatorId === operatorId && c.apn,
    );
    const fields: Record<string, string> = {
        type: "gsm",
        ifname: "",
        autoconnect: "yes",
        "connection.autoconnect-retries": "10",
        "ipv6.method": "ignore",
        "gsm.device-id": deviceId,
        "gsm.sim-id": iccid,
        "gsm.apn": donor?.apn ?? "internet",
        "gsm.home-only": "no", // allow roaming, matching belaUI's default
    };
    if (operatorId) fields["gsm.sim-operator-id"] = operatorId;
    const args = ["connection", "add"];
    for (const [key, value] of Object.entries(fields)) {
        args.push(key, value);
    }
    const out = await nmcli(...args);
    const uuid = out.match(/Connection '.+' \((.+)\) successfully added./)?.[1];
    if (uuid)
        console.log(`[modems] created gsm connection ${uuid} for ${deviceId}`);
    return uuid ?? null;
}

/** Bring a gsm connection up; true when NetworkManager reports it active. */
async function activateGsmConn(uuid: string): Promise<boolean> {
    const out = await nmcli("-w", String(ACTIVATE_TIMEOUT_S), "conn", "up", uuid);
    return out.includes("successfully activated");
}

/** Is a gsm connection currently active? */
async function gsmConnActive(uuid: string): Promise<boolean> {
    const state = (await nmcli("-t", "-f", "state", "connection", "show", uuid))
        .split("\n")[0];
    return state === "activated";
}

// ------------------------------------------------------------------------
// Control actions
// ------------------------------------------------------------------------

async function setModemEnabled(index: number, enabled: boolean): Promise<boolean> {
    await mmcli("-m", String(index), enabled ? "-e" : "-d");
    return true;
}

async function resetModem(index: number): Promise<boolean> {
    if (await mmcli("-m", String(index), "--reset")) return true;
    await setModemEnabled(index, false);
    await Bun.sleep(2000);
    await setModemEnabled(index, true);
    return true;
}

/** Look up a modem by index from the current scan. */
async function modemByIndex(index: number): Promise<ModemInfo | undefined> {
    return (await detectModems()).find((m) => m.index === index);
}

/** Connect: ensure the persistent gsm profile exists, then activate it. */
async function connectModem(index: number): Promise<boolean> {
    const modem = await modemByIndex(index);
    if (!modem) return false;
    const uuid = await ensureGsmConn(modem);
    if (!uuid) return false;
    return activateGsmConn(uuid);
}

/** Disconnect: deactivate the modem's gsm profile. */
async function disconnectModem(index: number): Promise<boolean> {
    const modem = await modemByIndex(index);
    if (!modem?.deviceId || !modem.simPath) return false;
    const { iccid } = await simFields(modem.simPath);
    if (!iccid) return false;
    const conn = await findGsmConn(modem.deviceId, iccid);
    if (!conn) return false;
    const out = await nmcli("conn", "down", conn.uuid);
    return out.includes("successfully deactivated");
}

const modemActions: Record<string, (index: number) => Promise<boolean>> = {
    enable: (index) => setModemEnabled(index, true),
    disable: (index) => setModemEnabled(index, false),
    reset: resetModem,
    connect: connectModem,
    disconnect: disconnectModem,
};

export async function performModemAction(
    action: string,
    index: number,
): Promise<boolean> {
    const perform = modemActions[action];
    if (!perform) throw new Error(`unknown modem action ${action}`);
    return perform(index);
}

// ------------------------------------------------------------------------
// Auto-dial / auto-reconnect loop (ported from belaUI.js updateModems)
// ------------------------------------------------------------------------

let autodialTimer: ReturnType<typeof setInterval> | null = null;
let autodialBusy = false;

/** MM modem states where bringing up the gsm connection is meaningful.
 * Registration states are suffixed (registered-home/roaming/denied). */
function dialReady(state: string): boolean {
    return (
        state.startsWith("registered") ||
        state === "connecting" ||
        state === "connected"
    );
}

/** One pass: ensure each registered modem has an active gsm connection. */
async function autodialTick(): Promise<void> {
    if (autodialBusy) return;
    autodialBusy = true;
    try {
        for (const modem of await detectModems()) {
            // Only dial when the modem is on the network (registered);
            // skip when disabled / scanning / not yet powered.
            if (!dialReady(modem.state)) continue;
            const uuid = await ensureGsmConn(modem);
            if (!uuid) continue;
            if (await gsmConnActive(uuid)) continue;
            console.log(
                `[modems] bringing up gsm connection ${uuid} for modem ${modem.index}`,
            );
            await activateGsmConn(uuid);
        }
    } finally {
        autodialBusy = false;
    }
}

/** Start the periodic auto-dial loop (idempotent). */
export function startModemAutodial(): void {
    if (autodialTimer) return;
    console.log(`[modems] auto-dial loop started (every ${AUTO_DIAL_MS}ms)`);
    // Run once immediately so a fresh boot dials without waiting a full tick.
    void autodialTick().catch((err: unknown) =>
        console.warn("[modems] autodial error:", errorMessage(err)),
    );
    autodialTimer = setInterval(() => {
        void autodialTick().catch((err: unknown) =>
            console.warn("[modems] autodial error:", errorMessage(err)),
        );
    }, AUTO_DIAL_MS);
}

/** Stop the periodic auto-dial loop. */
export function stopModemAutodial(): void {
    if (!autodialTimer) return;
    clearInterval(autodialTimer);
    autodialTimer = null;
}
