// Shared pure functions, constants, and internal-only types for the
// `systeminfo` module. Everything here is side-effect free so it stays unit
// testable; the sysfs/proc readers live in base.ts and the board-specific
// parsing in the providers.

import { $ } from "bun";
import type { PhysicalDiskInfo } from "./types";

/** Read a text file via `Bun.file` — returns null instead of throwing. */
export async function readFileSafe(p: string): Promise<string | null> {
    try {
        return await Bun.file(p).text();
    } catch {
        return null;
    }
}

/** List directory entries via Bun's shell (`ls -1`); [] on any failure. */
export async function listDir(p: string): Promise<string[]> {
    try {
        const out = await $`ls -1 ${p}`.quiet().text();
        return out.split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

// ARM implementer IDs → vendor name.
export const IMPLEMENTERS: Record<string, string> = {
    "0x41": "ARM",
    "0x42": "Broadcom",
    "0x43": "Cavium",
    "0x48": "HiSilicon",
    "0x4e": "Nvidia",
    "0x51": "Qualcomm",
    "0x53": "Samsung",
    "0x56": "Marvell",
    "0x61": "Apple",
};

// ARM CPU part IDs → core name (covers RPi, RK3588, most modern ARM SoCs).
export const CPU_PART_MAP: Record<string, string> = {
    "0xd03": "Cortex-A53",
    "0xd04": "Cortex-A35",
    "0xd05": "Cortex-A55",
    "0xd07": "Cortex-A57",
    "0xd08": "Cortex-A72",
    "0xd0b": "Cortex-A76",
    "0xd0c": "Neoverse-N1",
    "0xd40": "Neoverse-V1",
    "0xd44": "Cortex-X1",
    "0xd46": "Cortex-A510",
    "0xd47": "Cortex-A710",
    "0xd48": "Cortex-X2",
    "0xd49": "Neoverse-N2",
    "0xd4d": "Cortex-A715",
    "0xd4e": "Cortex-X3",
    "0xd81": "Cortex-A720",
    "0xd82": "Cortex-X4",
};

export interface CpuinfoParse {
    cores: number;
    fields: Record<string, string>;
}

/** Count `processor` entries and keep the last value of the interesting keys. */
export function parseCpuinfo(data: string): CpuinfoParse {
    const fields: Record<string, string> = {};
    const interesting = new Set([
        "model name",
        "Hardware",
        "Model",
        "Revision",
        "Serial",
        "CPU implementer",
        "CPU architecture",
        "CPU part",
        "CPU variant",
        "vendor_id",
        "CPU model",
    ]);
    let cores = 0;
    for (const line of data.split("\n")) {
        const i = line.indexOf(":");
        if (i === -1) continue;
        const key = line.slice(0, i).trim();
        const val = line.slice(i + 1).trim();
        if (key === "processor") cores++;
        else if (interesting.has(key)) fields[key] = val; // last-wins
    }
    return { cores, fields };
}

export interface CpuStatSample {
    idle: number;
    iowait: number;
    total: number;
}

/** Difference two per-core `/proc/stat` samples → busy percent overall + per core. */
export function computeCpuLoad(
    a: CpuStatSample[],
    b: CpuStatSample[],
): { overall: number; perCore: number[] } {
    const perCore: number[] = [];
    let work = 0;
    let delta = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const dt = b[i].total - a[i].total;
        const idle = b[i].idle + b[i].iowait - (a[i].idle + a[i].iowait);
        perCore.push(dt > 0 ? Math.round(((dt - idle) / dt) * 1000) / 10 : 0);
        work += dt - idle;
        delta += dt;
    }
    return {
        overall: delta > 0 ? Math.round((work / delta) * 1000) / 10 : 0,
        perCore,
    };
}

export interface DiskStatsEntry {
    readSectors: number;
    writeSectors: number;
    ioMs: number;
}

export interface DiskMeta {
    name: string;
    model: string;
    vendor: string;
    sizeBytes: number;
    removable: boolean;
    rotational: boolean;
}

/** Difference two `/proc/diskstats` samples → per-disk read/write bytes + util. */
export function computeDiskIo(
    a: Record<string, DiskStatsEntry>,
    b: Record<string, DiskStatsEntry>,
    sampleMs: number,
    metas: DiskMeta[],
): PhysicalDiskInfo[] {
    const dt = sampleMs / 1000;
    return metas.map((m) => {
        const sa = a[m.name];
        const sb = b[m.name];
        if (!sa || !sb) {
            return {
                ...m,
                readBytesPerSec: 0,
                writeBytesPerSec: 0,
                ioUtilization: 0,
            };
        }
        return {
            ...m,
            readBytesPerSec: Math.max(
                0,
                Math.round(((sb.readSectors - sa.readSectors) * 512) / dt),
            ),
            writeBytesPerSec: Math.max(
                0,
                Math.round(((sb.writeSectors - sa.writeSectors) * 512) / dt),
            ),
            ioUtilization: Math.max(
                0,
                Math.min(
                    100,
                    Math.round(((sb.ioMs - sa.ioMs) / sampleMs) * 1000) / 10,
                ),
            ),
        };
    });
}
