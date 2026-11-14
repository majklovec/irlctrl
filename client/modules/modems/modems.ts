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
import type {
	ModemInfo,
	ModemNetworkSetup,
	ModemSource,
	ScannedNetwork,
} from "./types";

let core: ModuleCore;

/** Bind the process services used by ModemManager / NetworkManager. */
export function bindModemManager(c: ModuleCore): void {
    core = c;
}

const mmcli = (...args: string[]) => core.run("mmcli", args, true);
/** mmcli that throws on failure — a scan or operator registration must not fail silently. */
const mmcliStrict = (...args: string[]) => core.run("mmcli", args, false);
const nmcli = (...args: string[]) => core.run("nmcli", args, true);

/** How often the auto-dial loop re-checks the modems (ms). */
const AUTO_DIAL_MS = 5000;
/** How long `nmcli conn up` may block before we give up on one modem (s). */
const ACTIVATE_TIMEOUT_S = 60;

/** ModemManager RAT names in generation order — the values `--set-allowed-modes`
 * and `--set-preferred-mode` accept (belaUI parity). `auto`/`none` are the
 * reserved "no fixed mode" tokens, not real bands. */
const RAT_ORDER = ["gsm", "umts", "lte", "nr5g"] as const;
const RAT_LABELS: Record<string, string> = {
    gsm: "2G (GSM)",
    umts: "3G (UMTS)",
    lte: "4G (LTE)",
    nr5g: "5G (NR)",
};
/** A value we accept for `--set-allowed-modes` / `--set-preferred-mode`. */
const isValidRat = (v: string): boolean =>
    (RAT_ORDER as readonly string[]).includes(v);

/** Split a ModemManager modes value ("gsm|lte" or "gsm, lte" or "auto") into
 * its RAT tokens. `auto` / empty are the "no fixed mode" sentinels. */
function splitModes(v: string | undefined): string[] {
    if (!v) return [];
    const trimmed = v.trim();
    if (!trimmed || trimmed.toLowerCase() === "auto") return [];
    return trimmed
        .split(/[|,]/)
        .map((s) => s.trim())
        .filter(isValidRat);
}

/** The modem's current band mode from `modem.generic.current-modes`
 * ("allowed: gsm, lte; preferred: lte"). Empty list = no fixed mode. */
function parseCurrentModes(
    detail: Record<string, string>,
): { allowed: string[]; preferred: string[] } {
    const raw = detail["modem.generic.current-modes"] ?? "";
    const allowed = raw.match(/allowed:\s*([^;]*)/)?.[1];
    const preferred = raw.match(/preferred:\s*([^;]*)/)?.[1];
    return { allowed: splitModes(allowed), preferred: splitModes(preferred) };
}

/** The RATs a modem can use, from `modem.generic.supported-modes` (a
 * keyvalue array of "allowed: …, …; preferred: …" strings, one per value). */
function supportedModes(detail: Record<string, string>): string[] {
    const set = new Set<string>();
    for (const [key, value] of Object.entries(detail)) {
        if (!/^modem\.generic\.supported-modes\.value\[\d+\]$/.test(key)) continue;
        for (const rat of splitModes(value.match(/allowed:\s*([^;]*)/)?.[1]))
            set.add(rat);
    }
    // Fall back to the current mode when the property is absent (some modems).
    if (!set.size) for (const rat of parseCurrentModes(detail).allowed) set.add(rat);
    return RAT_ORDER.filter((rat) => set.has(rat));
}

/** Human label for a RAT token; the raw token when unknown. */
export const ratLabel = (rat: string): string => RAT_LABELS[rat] ?? rat;

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
    info.currentModes = parseCurrentModes(detail);
    info.supportedModes = supportedModes(detail);
    return info;
}

/** The active bearer's IPv4 gateway (carrier route). Cellular gateways never
 * appear in the main routing table, so the network module reads this to build
 * a working per-uplink default route. The bearer index comes from the modem
 * detail (MM 1.20's `mmcli -m N -b` needs an explicit index). */
async function bearerGateway(index: number): Promise<string | undefined> {
    const detail = parseKeyvalue(
        await mmcli("-m", String(index), "--output-keyvalue"),
    );
    const bearer = pickField(detail, "modem.generic.bearers.value[1]")?.match(
        /Bearer\/(\d+)\s*$/,
    )?.[1];
    if (!bearer) return undefined;
    return (await mmcli("-b", bearer)).match(/gateway:\s*(\S+)/)?.[1];
}

async function scanModems(): Promise<ModemInfo[]> {
    const list = [...(await mmcli("-L")).matchAll(/Modem\/(\d+)\s+(.*)$/gm)];
    return Promise.all(
        list.map(async ([, index, label]) => {
            const info = await modemDetails(Number(index), label.trim());
            info.gateway = await bearerGateway(Number(index));
            return info;
        }),
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
    username?: string;
    /** The stored password — only readable when `passwordFlags` is 0 (visible). */
    password?: string;
    /** `gsm.password-flags`; 0 means the password is stored in plaintext. */
    passwordFlags?: number;
    /** `gsm.home-only` — `true` means roaming is disallowed. */
    homeOnly?: boolean;
    /** `gsm.auto-config` — NetworkManager manages the APN itself. */
    autoConfig?: boolean;
    /** `gsm.network-id` — the PLMN id the profile is pinned to. */
    networkId?: string;
}

/** The `gsm.*` profile fields a modem network setup surfaces (belaUI parity). */
export type GsmProfile = Pick<
    GsmConn,
    | "apn"
    | "username"
    | "password"
    | "passwordFlags"
    | "homeOnly"
    | "autoConfig"
    | "networkId"
>;

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
                [
                    "gsm.device-id",
                    "gsm.sim-id",
                    "gsm.sim-operator-id",
                    "gsm.apn",
                    "gsm.username",
                    "gsm.password",
                    "gsm.password-flags",
                    "gsm.home-only",
                    "gsm.auto-config",
                    "gsm.network-id",
                ].join(","),
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
            username: fields[4] || undefined,
            password: fields[5] || undefined,
            passwordFlags: fields[6] ? Number(fields[6]) : undefined,
            homeOnly: fields[7] === "yes",
            autoConfig: fields[8] === "yes",
            networkId: fields[9] || undefined,
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

/** Read the modem's persisted gsm profile (belaUI `modemGetConfig` read side):
 * the APN/username/password/roaming/auto-config/PLMN the frontend prefills.
 * Returns the profile when a bound connection exists, else `undefined`. */
export async function gsmProfile(
    index: number,
): Promise<Partial<GsmProfile> | undefined> {
    const mod = await modemByIndex(index);
    if (!mod?.deviceId || !mod.simPath) return undefined;
    const { iccid } = await simFields(mod.simPath);
    const conn = (await gsmConns()).find(
        (c) => c.deviceId === mod.deviceId && c.simId === iccid,
    );
    if (!conn) return undefined;
    return {
        apn: conn.apn,
        username: conn.username,
        // Only a plaintext-stored password (flags 0) is worth echoing back;
        // otherwise the field is empty and the UI treats it as "unchanged".
        password: conn.passwordFlags === 0 ? conn.password : undefined,
        // Expose the flag so the UI knows the stored password is hidden.
        passwordFlags: conn.passwordFlags,
        homeOnly: conn.homeOnly,
        autoConfig: conn.autoConfig,
        networkId: conn.networkId,
    };
}

/**
 * Delete stale gsm profiles bound to neither a modem (`device-id`) nor a SIM
 * (`sim-id`) — left over from re-enumerated / removed modems. These carry
 * `autoconnect=yes`, so they keep auto-dialing behind the active connection
 * and churn the "[modems] bringing up …" log. Best effort, runs at start.
 */
export async function pruneOrphanGsmConns(): Promise<number> {
    let removed = 0;
    for (const conn of await gsmConns()) {
        if (conn.deviceId || conn.simId) continue;
        const out = await nmcli("conn", "del", conn.uuid);
        if (out.includes("successfully deleted")) {
            removed++;
            console.log(`[modems] removed orphan gsm connection ${conn.uuid}`);
        } else {
            console.warn(
                `[modems] failed to remove orphan gsm connection ${conn.uuid}`,
            );
        }
    }
    if (removed) console.log(`[modems] pruned ${removed} orphan gsm connection(s)`);
    return removed;
}

/** ICCID + operator code of the modem's SIM, from the SIM object on D-Bus. */
async function simFields(
    simPath: string,
): Promise<{ iccid?: string; operatorId?: string }> {
    // D-Bus paths use the all-caps object name `SIM`.
    const m = simPath.match(/SIM\/(\d+)\s*$/);
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
    // `state` is only a list-mode field (detail mode needs `GENERAL.STATE`), so
    // ask list mode for every connection's active flag and find ours.
    const rows = (
        await nmcli("-t", "-f", "uuid,active", "connection", "show")
    ).split("\n");
    return rows.some((row) => row.startsWith(`${uuid}:yes`));
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

// ------------------------------------------------------------------------
// 3GPP network scan + operator/APN setup (ported from belaUI.js mmNetworkScan)
// ------------------------------------------------------------------------

/** How long a 3GPP network scan may block the radio (s). Full multi-band
 * sweeps are slow, so this is generous (belaUI.js uses 240 s). */
// Per-attempt radio budgets. A 3GPP sweep on the E3372 has been measured from
// ~13 s up to >250 s, independent of the data call — the window must cover a
// slow first pass; a retry covers the rare >4 min sweep. Worst case
// (240+180+180 + 2 pauses ≈ 724 s) fits under the 900 s frontend RPC budget.
const SCAN_TIMEOUTS_S = [240, 180, 180];

/**
 * Parse one `--3gpp-scan` entry into a ScannedNetwork. Two mmcli eras:
 *   * newer (1.20+): every field is a "key: value" pair separated by ", " —
 *     "operator-code: 23003, operator-name: Vodafone CZ,
 *      access-technologies: lte, availability: current"
 *   * older: a positional "MCC,MNC" prefix followed by plain-comma
 *     "key: value" fields — "505,01,status: current,access-tech: lte,
 *     operator-name: Telstra"
 * The newer form is recognized by its leading "key:" piece; a multi-value
 * field ("access-technologies: gsm, lte") splits on the inner ", " into a
 * bare continuation piece that gets appended back to the last key.
 */
export function parseScanNetworkEntry(
    entry: string,
): ScannedNetwork | null {
    const kv: Record<string, string> = {};
    let plmnId: string | undefined;
    let lastKey: string | undefined;
    const pieces = entry.split(", ").map((s) => s.trim()).filter(Boolean);
    if (pieces.length >= 2 && /^[\w-]+\s*:/.test(pieces[0])) {
        for (const piece of pieces) {
            const sep = piece.indexOf(":");
            if (sep > 0 && /^[\w-]+\s*$/.test(piece.slice(0, sep))) {
                lastKey = piece.slice(0, sep).trim();
                kv[lastKey] = piece.slice(sep + 1).trim();
            } else if (lastKey) {
                kv[lastKey] += ", " + piece;
            }
        }
        plmnId = kv["operator-code"];
    } else {
        const m = entry.match(/^(\d{3},\d{2,3}),(.*)$/);
        if (!m) return null;
        plmnId = m[1].replace(/\D/g, "");
        for (const piece of m[2].split(",")) {
            const sep = piece.indexOf(":");
            if (sep <= 0) continue;
            kv[piece.slice(0, sep).trim()] = piece.slice(sep + 1).trim();
        }
    }
    if (!plmnId || !/^\d{5,6}$/.test(plmnId)) return null;
    return {
        plmn: `${plmnId.slice(0, 3)},${plmnId.slice(3)}`,
        plmnId,
        status: kv["availability"] ?? kv["status"] ?? "unknown",
        accessTech: kv["access-technologies"] ?? kv["access-tech"],
        operatorName: kv["operator-name"],
    };
}

/** One raw mmcli scan, parsed into PLMN objects. Throws on mmcli failure. */
async function runScan(
    index: number,
    timeoutS: number,
): Promise<ScannedNetwork[]> {
    const kv = parseKeyvalue(
        await mmcliStrict(
            `--timeout=${timeoutS}`,
            "-m",
            String(index),
            "--3gpp-scan",
            "--output-keyvalue",
        ),
    );
    return Object.entries(kv)
        .filter(([key]) => key.startsWith("modem.3gpp.scan-networks.value["))
        .sort(
            ([a], [b]) =>
                Number(a.match(/value\[(\d+)\]$/)?.[1]) -
                Number(b.match(/value\[(\d+)\]$/)?.[1]),
        )
        .map(([, entry]) => parseScanNetworkEntry(entry))
        .filter((net): net is ScannedNetwork => net !== null);
}

/**
 * Scan the visible 3GPP networks (PLMNs) of one modem with
 * `mmcli --3gpp-scan` and return them as plain objects. Scans are slow and
 * flaky — a full band sweep has timed out over 240 s sporadically — so a
 * transient failure (NetworkTimeout, empty sweep) is retried a couple of
 * times before the error is surfaced to the caller.
 */
export async function scanMobileNetworks(
    index: number,
): Promise<ScannedNetwork[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < SCAN_TIMEOUTS_S.length; attempt++) {
        const timeoutS = SCAN_TIMEOUTS_S[attempt];
        if (!timeoutS) continue;
        try {
            const networks = await runScan(index, timeoutS);
            if (networks.length) return networks;
            // An empty sweep can be a transient radio state — retry.
            lastError = new Error("scan returned no networks");
        } catch (err: unknown) {
            const message =
                err instanceof Error ? err.message : String(err);
            // Covers "Network timeout", "Timeout was reached", "timed out",
            // "modem busy", …
            const transient = /timeout|timed out|busy/i.test(message);
            lastError = err;
            if (!transient) throw err; // hard failure (no modem, no SIM, …)
        }
        if (attempt < SCAN_TIMEOUTS_S.length - 1) await Bun.sleep(2_000);
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
}

/** Deactivate the modem's gsm profile when it is active (best effort). */
async function deactivateGsmConn(index: number): Promise<boolean> {
    const modem = await modemByIndex(index);
    if (!modem?.deviceId || !modem.simPath) return false;
    const { iccid } = await simFields(modem.simPath);
    if (!iccid) return false;
    const conn = await findGsmConn(modem.deviceId, iccid);
    if (!conn) return false;
    const out = await nmcli("conn", "down", conn.uuid);
    return out.includes("successfully deactivated");
}

/** Set the 3GPP packet-service (data) state; best effort. */
const packetService = (index: number, state: "attached" | "detached") =>
    mmcli("-m", String(index), "--3gpp-set-packet-service-state", state);

/** The modem's current state (the `modem.generic.state` property). */
async function modemState(index: number): Promise<string | undefined> {
    return (
        await mmcli("-m", String(index), "--output-keyvalue")
    ).match(/modem\.generic\.state\s*:\s*(\S+)/)?.[1];
}

/** Poll the modem state until `accept` matches, or the deadline passes. */
async function waitModemState(
    index: number,
    accept: (state: string | undefined) => boolean,
    timeoutMs: number,
): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (accept(await modemState(index))) return;
        await Bun.sleep(500);
    }
}

// ------------------------------------------------------------------------
// Band mode (belaUI parity — mmSetNetworkTypes)
// ------------------------------------------------------------------------

/**
 * Set the modem's allowed/preferred radio bands, mirroring belaUI.js
 * `mmSetNetworkTypes`: `mmcli -m <id> --set-allowed-modes=<A|B[|…]>`
 * [plus `--set-preferred-mode=<M>` when a preferred band is chosen]. An empty
 * `allowed` list means "auto" (no fixed band). Returns true on the modem's
 * "successfully set current modes" confirmation.
 */
export async function setModemModes(
    index: number,
    allowed: readonly string[],
    preferred?: string,
): Promise<boolean> {
    const rats = allowed
        .filter((v) => isValidRat(v))
        .map((v) => v.toUpperCase());
    // Dedupe while preserving generation order (gsm < umts < lte < nr5g).
    const allowedList = RAT_ORDER.map((r) => r.toUpperCase()).filter((r) =>
        rats.includes(r),
    );
    const pref = preferred && allowedList.includes(preferred.toUpperCase())
        ? preferred.toUpperCase()
        : undefined;
    if (!allowedList.length && !pref) return true; // nothing to change
    const args = [
        "-m",
        String(index),
        `--set-allowed-modes=${allowedList.join("|")}`,
    ];
    if (pref) args.push(`--set-preferred-mode=${pref}`);
    try {
        return (
            await mmcliStrict(...args)
        ).includes("successfully set current modes");
    } catch (err) {
        console.log(`[modems] setModes: ${errorMessage(err)}`);
        return false;
    }
}

// ------------------------------------------------------------------------
// Operator-name cache (belaUI parity — gsmOperators)
// ------------------------------------------------------------------------

interface ModemsSection {
    operators?: Record<string, string>;
}
function modemsSection(): ModemsSection {
    const section = core.state.data.modems;
    return (
        (typeof section === "object" && section
            ? (section as ModemsSection)
            : (core.state.data.modems = {})) as ModemsSection
    );
}

/** Remember that PLMN id `id` belongs to `name` (persisted across restarts). */
function rememberOperator(id: string, name: string): void {
    if (!id || !name) return;
    const cache = (modemsSection().operators ??= {});
    if (cache[id] !== name) {
        cache[id] = name;
        void core.saveState().catch(() => {});
    }
}

/** Look a PLMN id up in the operator cache (fallback for nameless scan rows). */
function cachedOperator(id: string): string | undefined {
    return id ? modemsSection().operators?.[id] : undefined;
}

// ------------------------------------------------------------------------
// Network setup (belaUI parity — handleModemConfig + modemConfigSantizeToNM)
// ------------------------------------------------------------------------

/** Map a setup onto the `gsm.*` NetworkManager fields the profile carries.
 * `undefined` fields are omitted so a call can touch a subset (belaUI
 * `modemConfigSantizeToNM` — auto-config clears apn/user/pass; roaming off
 * means home-only; the PLMN pin is stored in `gsm.network-id`). */
export function setupToGsmFields(
    setup: ModemNetworkSetup,
): Record<string, string> {
    const fields: Record<string, string> = {};
    if (setup.autoConfig !== undefined)
        fields["gsm.auto-config"] = setup.autoConfig ? "yes" : "no";
    if (setup.autoConfig) {
        // Auto-config: NetworkManager owns the APN — clear the manual ones.
        if (setup.apn === undefined) fields["gsm.apn"] = "";
        if (setup.username === undefined) fields["gsm.username"] = "";
        if (setup.password === undefined) fields["gsm.password"] = "";
    } else if (setup.apn !== undefined) fields["gsm.apn"] = setup.apn;
    if (setup.username !== undefined) fields["gsm.username"] = setup.username;
    if (setup.password !== undefined) {
        fields["gsm.password"] = setup.password;
        // password-flags 0 = stored in plaintext (readable by `gsmProfile`).
        fields["gsm.password-flags"] = setup.password ? "0" : "4";
    }
    if (setup.allowRoaming !== undefined)
        fields["gsm.home-only"] = setup.allowRoaming ? "no" : "yes";
    if (setup.plmn !== undefined)
        fields["gsm.network-id"] = setup.allowRoaming ? setup.plmn : "";
    return fields;
}

/**
 * Apply a `ModemNetworkSetup` to a modem and redial (belaUI
 * `handleModemConfig`): update the persistent gsm profile's `gsm.*` fields,
 * set the radio band mode (when it changed), then bring the connection up.
 * Every field of `setup` is optional — `undefined` leaves that setting as-is.
 * Returns true when the connection comes up.
 */
export async function setupModemNetwork(
    index: number,
    setup: ModemNetworkSetup,
): Promise<boolean> {
    const modem = await modemByIndex(index);
    if (!modem) return false;

    // Cache the operator name for a selected network (belaUI parity).
    if (setup.plmn && setup.operatorName)
        rememberOperator(setup.plmn, setup.operatorName);

    // 1. Band mode — set before wiring the data call (belaUI sets modes while
    //    the connection is down).
    if (setup.allowedModes !== undefined)
        await setModemModes(
            index,
            setup.allowedModes,
            setup.preferredMode,
        );

    // 2. PLMN pin — a new network requires a fresh registration (belaUI drops
    //    the call, `--3gpp-register-in-operator`, then re-dials).
    if (setup.plmn) {
        await deactivateGsmConn(index);
        await packetService(index, "detached");
        try {
            // RegisterToOperator is refused while a bearer is active — wait
            // for the state to leave "connected" (→ searching / registered).
            await waitModemState(index, (s) => s !== "connected", 15_000);
            await mmcliStrict(
                "-m",
                String(index),
                "--3gpp-register-in-operator",
                setup.plmn,
            );
            // Let the attach settle before the data call comes back.
            await waitModemState(
                index,
                (s) => s?.startsWith("registered") || s === "connected",
                30_000,
            );
        } finally {
            // Never leave the modem's data service detached.
            await packetService(index, "attached");
        }
    }

    // 3. Profile fields, then bring the connection up.
    const uuid = await ensureGsmConn(modem);
    if (!uuid) return false;
    const gsmFields = setupToGsmFields(setup);
    if (Object.keys(gsmFields).length) {
        const args = ["con", "modify", uuid];
        for (const [key, value] of Object.entries(gsmFields)) {
            args.push(key, value);
        }
        await nmcli(...args);
    }
    return activateGsmConn(uuid);
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
