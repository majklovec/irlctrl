/*
 * ModemManager integration used by the SRTLA device module: enumerate modems,
 * resolve their network interfaces, and perform modem control actions.
 */
import type { ModuleCore } from "../../backend/client/module-core";
import type { ModemInfo, ModemSource } from "./types";

let core: ModuleCore;

/** Bind the process services used by ModemManager. */
export function bindModemManager(c: ModuleCore): void {
    core = c;
}

const mmcli = (...args: string[]) => core.run("mmcli", args, true);

/** `mmcli -m <n>` labels of the plain-text fields we keep. */
const DETAIL_FIELDS = {
    state: "state",
    powerState: "power state",
    model: "model",
    manufacturer: "manufacturer",
    imei: "imei",
    primaryPort: "primary port",
    deviceId: "device id",
    simPath: "sim",
    operatorName: "operator name",
    registrationState: "registration",
    accessTech: "access tech",
} as const satisfies Record<string, string>;

async function modemDetails(index: number, label: string): Promise<ModemInfo> {
    const detail = await mmcli("-m", String(index));
    const grab = (name: string) =>
        detail.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "m"))?.[1].trim();
    const info: ModemInfo = {
        index,
        path: `/org/freedesktop/ModemManager1/Modem/${index}`,
        state: "unknown",
        powerState: "unknown",
    };
    for (const [key, name] of Object.entries(DETAIL_FIELDS)) {
        const value = grab(name);
        if (value !== undefined)
            (info as unknown as Record<string, string>)[key] = value;
    }
    info.model ??= label;
    const signal = grab("signal quality")?.match(/(\d+)/);
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

const modemActions: Record<string, (index: number) => Promise<boolean>> = {
    enable: (index) => setModemEnabled(index, true),
    disable: (index) => setModemEnabled(index, false),
    reset: resetModem,
    connect: async (index) =>
        (await mmcli(
            "-m",
            String(index),
            "--simple-connect=apn=internet",
        )).length > 0,
    disconnect: async (index) =>
        (await mmcli("-m", String(index), "--simple-disconnect")).length > 0,
};

export async function performModemAction(
    action: string,
    index: number,
): Promise<boolean> {
    const perform = modemActions[action];
    if (!perform) throw new Error(`unknown modem action ${action}`);
    return perform(index);
}
