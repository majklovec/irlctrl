# 🤖 AI Agent Handoff — `systeminfo` Module for `majklovec/irlctrl`

> **Read this document top-to-bottom before touching code.** It is a complete, self-contained specification. Everything you need to create the module is in §4. Nothing outside `client/modules/systeminfo/` should be modified. **Frontend components use JSX, not `m(...)` calls.**

---

## 1. Objective & Scope

Add a new device module **`systeminfo`** to the [irlctrl](https://github.com/majklovec/irlctrl) repository that:

1. **Runs on every device role** (`relay`, `encoder`, `obs`, `broadcaster`) — implemented by **omitting** the `roles` field on the `BackendModule`.
2. **Exposes a device card** with live hardware telemetry (CPU load, temperatures, memory, disks, network, board-specific extras).
3. **Renders as the last card before the log section** — achieved via `FrontendModule.order = 1000` (higher than every other card).
4. **Supports two boards out of the box**: **Orange Pi 5 Plus (RK3588)** and **Raspberry Pi (BCM2711 / BCM2712 / BCM2837)**.
5. **Uses Bun shell (`Bun.$`), `Bun.file`, `Bun.sleep`** — no external npm dependencies.
6. **Frontend uses JSX** (`jsxFactory: m`) — no `m("div", …)` vnode calls in component bodies; JSX everywhere hypertext is needed.

**Out of scope:** editing core files (`shared/`, `scripts/`, `client/backend/`, `client/frontend/`). The module system auto-discovers contributions.

---

## 2. Repository Context

| Item                  | Location / Contract                                                                                       |
| :-------------------- | :-------------------------------------------------------------------------------------------------------- |
| **Runtime**           | Bun 1.1+ (`Bun.$`, `Bun.file`, `Bun.sleep` are stable; JSX is built-in).                                  |
| **Module root**       | `client/modules/<id>/`                                                                                    |
| **Backend contract**  | `shared/contracts/backend_module.ts` → `BackendModule`                                                    |
| **Frontend contract** | `shared/contracts/frontend_module.ts` → `FrontendModule` (`kind: "device-card"`)                          |
| **Module core bag**   | `client/backend/module_core.ts` → `ModuleCore` (provides `state`, `saveState`, `logEvent`, `run`, `log`)  |
| **Frontend RPC**      | `shared/ui/services/rpc.ts` (verify exact path — likely `client/ui/services/rpc.ts`)                      |
| **Discovery**         | Automatic scan via `scripts/gen_modules.ts` (run by `predev`/`prebuild`). No core edits.                  |
| **Card ordering**     | Ascending `FrontendModule.order` — the log renders after all cards, so `order: 1000` = last before log.   |
| **JSX config**        | Bun respects `tsconfig.json`'s `"jsx": "react"` + `"jsxFactory": "m"` — see §3.1.                         |
| **Test suite**        | `bun test` — `test/registries.test.ts` validates every module against the contract. **Must still pass.**  |
| **Sample modules**    | `client/modules/ssh/` (backend‑only), `client/modules/network/` (with card) — copy their structure/paths. |

**Key contracts used below** (verify against actual files if they differ — this is what the code assumes):

```typescript
// shared/contracts/backend_module.ts (assumed shape)
interface BackendModule {
    kind: "device";
    id: string;
    title: string;
    roles?: ("relay" | "encoder" | "obs" | "broadcaster")[]; // omit = all roles
    methods: string[];
    events: string[];
    start(ctx: {
        core: ModuleCore;
        log: (tag: string, msg: string) => void;
    }): Promise<void>;
    stop(): Promise<void>;
    dispatch(method: string, params: unknown): Promise<unknown>;
    status(): Promise<Record<string, unknown>>;
}

// shared/contracts/frontend_module.ts (assumed shape)
interface FrontendModule {
    kind: "device-card";
    id: string;
    title: string;
    order: number;
    defaultSize: { w: number; h: number };
    minSize: { w: number; h: number };
    available: (status: Status) => boolean;
    component: () => m.Component;
}
```

If any of these differ, **adapt `backend.ts` / `frontend.tsx` only** — the providers (§4.4–§4.6) are contract‑agnostic and will not need to change.

---

## 3. Setup & File Tree

### 3.1 `tsconfig.json` (root) — required for JSX

Confirm the root `tsconfig.json` contains the Mithril JSX configuration. If it already does (likely — check `client/modules/network/frontend.tsx`), skip this.

```jsonc
{
    "compilerOptions": {
        // ... existing options ...
        "jsx": "react",
        "jsxFactory": "m",
        "jsxFragmentFactory": "m.Fragment",
    },
}
```

If for policy reasons you cannot edit the root `tsconfig.json`, put a per-file pragma at the top of every `.tsx` file:

```tsx
/** @jsx m */
/** @jsxFrag m.Fragment */
import m from "mithril";
```

The snippet in §4.9 uses the tsconfig approach — no pragma needed.

### 3.2 Target File Tree

```
client/modules/systeminfo/
├── types.ts                      ← public TypeScript interfaces
├── helpers.ts                    ← pure helpers, constants, internal types
├── base.ts                       ← abstract LinuxSystemInfoProvider
├── factory.ts                    ← createSystemInfoProvider (auto-detect)
├── backend.ts                    ← BackendModule
├── frontend.tsx                  ← FrontendModule (order: 1000) — JSX
├── styles.css                    ← card styling
├── i18n/
│   └── en.json                   ← UI strings
└── providers/
    ├── orange_pi_5_plus.ts       ← OrangePi5PlusSystemInfo
    └── raspberry_pi.ts           ← RaspberryPiSystemInfo
```

**Dependency direction (no cycles):**

```
types.ts ← helpers.ts ← base.ts ← providers/*.ts ← factory.ts ← backend.ts
                                                     ↑
                                              frontend.tsx (only types.ts)
```

---

## 4. Full Source

### 4.1 `types.ts`

```typescript
// client/modules/systeminfo/types.ts

export interface BoardInfo {
    model: string; // "Orange Pi 5 Plus" | "Raspberry Pi 5 Model B Rev 1.0"
    vendor: string; // "Xunlong" | "Raspberry Pi Foundation"
    platformName: string; // human-friendly identifier
}

export interface CpuInfo {
    model: string;
    manufacturer: string;
    architecture: string;
    cores: number;
    speedMHz: number;
    overallLoad: number; // percent, filled by getSystemInfo()
    loadPerCore: number[]; // percent per core, filled by getSystemInfo()
}

export interface TemperatureSensor {
    zone: string; // "thermal_zone0"
    type: string; // "soc-thermal" | "cpu-thermal" | "vcgencmd-gpu"
    label?: string; // board-specific human label ("SoC", "Big Core 0", …)
    tempC: number;
}

export interface FanSpeed {
    name: string;
    rpm: number;
}
export interface Voltage {
    name: string;
    volts: number;
}

export interface ThrottlingState {
    underVoltage: boolean;
    armFreqCapped: boolean;
    currentlyThrottled: boolean;
    softTempLimit: boolean;
    raw?: number;
}

export interface MemoryInfo {
    totalBytes: number;
    freeBytes: number;
    availableBytes: number;
    usedBytes: number;
    buffersBytes: number;
    cachedBytes: number;
    swapTotalBytes: number;
    swapFreeBytes: number;
    swapUsedBytes: number;
}

export interface FilesystemInfo {
    device: string;
    mount: string;
    type: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usePercent: number;
}

export interface PhysicalDiskInfo {
    name: string;
    model: string;
    vendor: string;
    sizeBytes: number;
    removable: boolean;
    rotational: boolean;
    readBytesPerSec: number;
    writeBytesPerSec: number;
    ioUtilization: number;
}

export interface NetworkInterfaceInfo {
    iface: string;
    mac: string;
    ip4?: string;
    ip6?: string;
    internal: boolean;
    operState?: string;
    speedMbps?: number;
    rxBytesPerSec?: number;
    txBytesPerSec?: number;
}

export interface OsInfo {
    platform: string;
    distro: string;
    version: string;
    kernel: string;
    arch: string;
    hostname: string;
    uptimeSec: number;
    loadAvg: [number, number, number];
}

export interface SystemInfo {
    board: BoardInfo;
    os: OsInfo;
    cpu: CpuInfo;
    temperatures: TemperatureSensor[];
    fans: FanSpeed[];
    voltages: Voltage[];
    throttling?: ThrottlingState;
    memory: MemoryInfo;
    filesystems: FilesystemInfo[];
    physicalDisks: PhysicalDiskInfo[];
    network: NetworkInterfaceInfo[];
}
```

---

### 4.2 `helpers.ts`

```typescript
// client/modules/systeminfo/helpers.ts
// Shared pure functions, constants, and internal-only types.

import { $ } from "bun";
import type { PhysicalDiskInfo } from "./types";

/** Read a text file via Bun.file — returns null instead of throwing. */
export async function readFileSafe(p: string): Promise<string | null> {
    try {
        return await Bun.file(p).text();
    } catch {
        return null;
    }
}

/** List directory entries via Bun's shell (`ls -1`). */
export async function listDir(p: string): Promise<string[]> {
    try {
        const out = await $`ls -1 ${p}`.quiet().text();
        return out.split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

// ARM implementer IDs → vendor name
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

// ARM CPU part IDs → core name (covers RPi, RK3588, most modern ARM SoCs)
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

export function computeCpuLoad(a: CpuStatSample[], b: CpuStatSample[]) {
    const perCore: number[] = [];
    let work = 0,
        delta = 0;
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

export function computeDiskIo(
    a: Record<string, DiskStatsEntry>,
    b: Record<string, DiskStatsEntry>,
    sampleMs: number,
    metas: DiskMeta[],
): PhysicalDiskInfo[] {
    const dt = sampleMs / 1000;
    return metas.map((m) => {
        const sa = a[m.name],
            sb = b[m.name];
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
```

---

### 4.3 `base.ts` — the abstract template

```typescript
// client/modules/systeminfo/base.ts

import * as os from "node:os";
import { $ } from "bun";
import type {
    BoardInfo,
    CpuInfo,
    TemperatureSensor,
    ThrottlingState,
    MemoryInfo,
    FilesystemInfo,
    NetworkInterfaceInfo,
    OsInfo,
    FanSpeed,
    Voltage,
    SystemInfo,
} from "./types";
import {
    readFileSafe,
    listDir,
    parseCpuinfo,
    computeCpuLoad,
    computeDiskIo,
    type CpuStatSample,
    type DiskStatsEntry,
    type DiskMeta,
} from "./helpers";

export abstract class LinuxSystemInfoProvider {
    // ---- Subclasses MUST implement ----
    abstract getBoardInfo(): Promise<BoardInfo>;
    abstract getCpuInfo(): Promise<
        Omit<CpuInfo, "overallLoad" | "loadPerCore">
    >;
    abstract getTemperatures(): Promise<TemperatureSensor[]>;

    // ---- Subclasses MAY override ----
    protected async getThrottlingState(): Promise<ThrottlingState | undefined> {
        return undefined;
    }

    // ---- Public template method ----
    async getSystemInfo(sampleMs = 1000): Promise<SystemInfo> {
        const cpuA = await this.readProcStat();
        const diskA = await this.readDiskstats();
        const netA = await this.readNetDev();

        await Bun.sleep(sampleMs);

        const [
            cpuB,
            diskB,
            netB,
            board,
            osInfo,
            cpuBase,
            temperatures,
            fans,
            voltages,
            throttling,
            memory,
            filesystems,
            diskMeta,
        ] = await Promise.all([
            this.readProcStat(),
            this.readDiskstats(),
            this.readNetDev(),
            this.getBoardInfo(),
            this.getOsInfo(),
            this.getCpuInfo(),
            this.getTemperatures(),
            this.getFanSpeeds(),
            this.getVoltages(),
            this.getThrottlingState().catch(() => undefined),
            this.getMemory(),
            this.getFilesystems(),
            this.getDiskMeta(),
        ]);

        const load = computeCpuLoad(cpuA, cpuB);
        const cpu: CpuInfo = {
            ...cpuBase,
            overallLoad: load.overall,
            loadPerCore: load.perCore,
        };

        return {
            board,
            os: osInfo,
            cpu,
            temperatures,
            fans,
            voltages,
            throttling,
            memory,
            filesystems,
            physicalDisks: computeDiskIo(diskA, diskB, sampleMs, diskMeta),
            network: await this.buildNetworkInfo(netA, netB, sampleMs),
        };
    }

    // ---- Generic /sys & /proc readers (all via Bun.file / Bun.$) ----
    protected async readSysfsThermalZones(): Promise<TemperatureSensor[]> {
        const zones = (await listDir("/sys/class/thermal"))
            .filter((e) => /^thermal_zone\d+$/.test(e))
            .sort();
        const out: TemperatureSensor[] = [];
        for (const zone of zones) {
            const t = await readFileSafe(`/sys/class/thermal/${zone}/temp`);
            if (!t) continue;
            const millis = parseInt(t.trim(), 10);
            if (!Number.isFinite(millis)) continue;
            const type =
                (
                    await readFileSafe(`/sys/class/thermal/${zone}/type`)
                )?.trim() ?? "unknown";
            out.push({
                zone,
                type,
                tempC: Math.round((millis / 1000) * 10) / 10,
            });
        }
        return out;
    }

    protected async getCpuSpeedMHz(): Promise<number> {
        const entries = await listDir("/sys/devices/system/cpu");
        let sum = 0,
            n = 0;
        for (const e of entries) {
            if (!/^cpu\d+$/.test(e)) continue;
            const raw = await readFileSafe(
                `/sys/devices/system/cpu/${e}/cpufreq/scaling_cur_freq`,
            );
            if (raw) {
                sum += parseInt(raw, 10) / 1000;
                n++;
            }
        }
        return n ? Math.round(sum / n) : 0;
    }

    protected async readProcStat(): Promise<CpuStatSample[]> {
        const data = await readFileSafe("/proc/stat");
        if (!data) return [];
        const out: CpuStatSample[] = [];
        for (const line of data.split("\n")) {
            if (!/^cpu\d+\s/.test(line)) continue;
            const nums = line.trim().split(/\s+/).slice(1).map(Number);
            const idle = nums[3] ?? 0,
                iowait = nums[4] ?? 0;
            out.push({ idle, iowait, total: nums.reduce((a, b) => a + b, 0) });
        }
        return out;
    }

    protected async getMemory(): Promise<MemoryInfo> {
        const data = await readFileSafe("/proc/meminfo");
        const kv: Record<string, number> = {};
        if (data) {
            for (const line of data.split("\n")) {
                const m = /^(\w+):\s+(\d+)/.exec(line);
                if (m) kv[m[1]] = parseInt(m[2], 10);
            }
        }
        const toB = (k?: number) => (k ?? 0) * 1024;
        const total = toB(kv.MemTotal),
            free = toB(kv.MemFree);
        const available = toB(kv.MemAvailable) || free;
        const swapTotal = toB(kv.SwapTotal),
            swapFree = toB(kv.SwapFree);
        return {
            totalBytes: total,
            freeBytes: free,
            availableBytes: available,
            usedBytes: Math.max(0, total - available),
            buffersBytes: toB(kv.Buffers),
            cachedBytes: toB(kv.Cached),
            swapTotalBytes: swapTotal,
            swapFreeBytes: swapFree,
            swapUsedBytes: swapTotal - swapFree,
        };
    }

    private static SKIP_FS = new Set([
        "proc",
        "sysfs",
        "devtmpfs",
        "devpts",
        "cgroup",
        "cgroup2",
        "pstore",
        "bpf",
        "tracefs",
        "debugfs",
        "securityfs",
        "configfs",
        "fusectl",
        "mqueue",
        "hugetlbfs",
        "binfmt_misc",
        "autofs",
        "nsfs",
        "efivarfs",
        "selinuxfs",
        "rpc_pipefs",
        "squashfs",
        "overlay",
        "tmpfs",
        "ramfs",
    ]);

    protected async getFilesystems(): Promise<FilesystemInfo[]> {
        let output: string;
        try {
            output = await $`df -B1 -T`.quiet().text();
        } catch {
            return [];
        }

        const lines = output.split("\n").slice(1);
        const out: FilesystemInfo[] = [];
        for (const line of lines) {
            const p = line.trim().split(/\s+/);
            if (p.length < 7) continue;
            const [device, type, totalB, usedB, , , ...mountParts] = p;
            if (LinuxSystemInfoProvider.SKIP_FS.has(type)) continue;
            const total = parseInt(totalB, 10);
            const used = parseInt(usedB, 10);
            const free = Math.max(0, total - used);
            if (!Number.isFinite(total) || total === 0) continue;
            out.push({
                device,
                type,
                mount: mountParts.join(" "),
                totalBytes: total,
                freeBytes: free,
                usedBytes: used,
                usePercent: Math.round((used / total) * 1000) / 10,
            });
        }
        return out;
    }

    protected async getDiskMeta(): Promise<DiskMeta[]> {
        const names = (await listDir("/sys/block")).filter(
            (n) => !/^(loop|ram|zram|dm-|sr\d)/.test(n),
        );
        const out: DiskMeta[] = [];
        for (const name of names) {
            const sizeRaw = await readFileSafe(`/sys/block/${name}/size`);
            if (!sizeRaw) continue;
            const sizeBytes = parseInt(sizeRaw, 10) * 512;
            if (sizeBytes <= 0) continue;
            out.push({
                name,
                model:
                    (
                        await readFileSafe(`/sys/block/${name}/device/model`)
                    )?.trim() || name,
                vendor:
                    (
                        await readFileSafe(`/sys/block/${name}/device/vendor`)
                    )?.trim() ?? "",
                sizeBytes,
                removable:
                    (
                        await readFileSafe(`/sys/block/${name}/removable`)
                    )?.trim() === "1",
                rotational:
                    (
                        await readFileSafe(
                            `/sys/block/${name}/queue/rotational`,
                        )
                    )?.trim() === "1",
            });
        }
        return out;
    }

    protected async readDiskstats(): Promise<Record<string, DiskStatsEntry>> {
        const data = await readFileSafe("/proc/diskstats");
        const out: Record<string, DiskStatsEntry> = {};
        if (!data) return out;
        for (const line of data.split("\n")) {
            const p = line.trim().split(/\s+/);
            if (p.length < 14) continue;
            out[p[2]] = {
                readSectors: parseInt(p[5], 10),
                writeSectors: parseInt(p[9], 10),
                ioMs: parseInt(p[12], 10),
            };
        }
        return out;
    }

    protected async readNetDev(): Promise<
        Record<string, { rx: number; tx: number }>
    > {
        const data = await readFileSafe("/proc/net/dev");
        const out: Record<string, { rx: number; tx: number }> = {};
        if (!data) return out;
        for (const line of data.split("\n")) {
            const m = /^\s*([^:]+):\s*(.+)$/.exec(line);
            if (!m) continue;
            const f = m[2].trim().split(/\s+/);
            if (f.length < 9) continue;
            out[m[1].trim()] = {
                rx: parseInt(f[0], 10),
                tx: parseInt(f[8], 10),
            };
        }
        return out;
    }

    protected async buildNetworkInfo(
        a: Record<string, { rx: number; tx: number }>,
        b: Record<string, { rx: number; tx: number }>,
        sampleMs: number,
    ): Promise<NetworkInterfaceInfo[]> {
        const dt = sampleMs / 1000;
        const ifaces = os.networkInterfaces();
        const out: NetworkInterfaceInfo[] = [];
        for (const [iface, addrs] of Object.entries(ifaces)) {
            if (!addrs) continue;
            const ip4 = addrs.find(
                (x) => (x.family as any) === "IPv4" || (x.family as any) === 4,
            )?.address;
            const ip6 = addrs.find(
                (x) => (x.family as any) === "IPv6" || (x.family as any) === 6,
            )?.address;
            const mac = addrs[0]?.mac ?? "";
            const internal = addrs.every((x) => x.internal);
            const operState = (
                await readFileSafe(`/sys/class/net/${iface}/operstate`)
            )?.trim();

            let speedMbps: number | undefined;
            const speedRaw = await readFileSafe(
                `/sys/class/net/${iface}/speed`,
            );
            if (speedRaw) {
                const n = parseInt(speedRaw, 10);
                if (Number.isFinite(n) && n > 0 && n < 1_000_000) speedMbps = n;
            }

            let rxBytesPerSec: number | undefined,
                txBytesPerSec: number | undefined;
            if (a[iface] && b[iface]) {
                rxBytesPerSec = Math.max(
                    0,
                    Math.round((b[iface].rx - a[iface].rx) / dt),
                );
                txBytesPerSec = Math.max(
                    0,
                    Math.round((b[iface].tx - a[iface].tx) / dt),
                );
            }
            out.push({
                iface,
                mac,
                ip4,
                ip6,
                internal,
                operState,
                speedMbps,
                rxBytesPerSec,
                txBytesPerSec,
            });
        }
        return out;
    }

    protected async getFanSpeeds(): Promise<FanSpeed[]> {
        const out: FanSpeed[] = [];
        const hwmons = (await listDir("/sys/class/hwmon")).filter((x) =>
            /^hwmon\d+$/.test(x),
        );
        for (const hw of hwmons) {
            const base = `/sys/class/hwmon/${hw}`;
            const chip = (await readFileSafe(`${base}/name`))?.trim() ?? hw;
            const entries = await listDir(base);
            for (const e of entries) {
                const m = /^fan(\d+)_input$/.exec(e);
                if (!m) continue;
                const raw = await readFileSafe(`${base}/${e}`);
                if (!raw) continue;
                const rpm = parseInt(raw, 10);
                if (Number.isFinite(rpm))
                    out.push({ name: `${chip}:fan${m[1]}`, rpm });
            }
        }
        return out;
    }

    protected async getVoltages(): Promise<Voltage[]> {
        const out: Voltage[] = [];
        const hwmons = (await listDir("/sys/class/hwmon")).filter((x) =>
            /^hwmon\d+$/.test(x),
        );
        for (const hw of hwmons) {
            const base = `/sys/class/hwmon/${hw}`;
            const chip = (await readFileSafe(`${base}/name`))?.trim() ?? hw;
            const entries = await listDir(base);
            for (const e of entries) {
                const m = /^in(\d+)_input$/.exec(e);
                if (!m) continue;
                const raw = await readFileSafe(`${base}/${e}`);
                if (!raw) continue;
                const mv = parseInt(raw, 10);
                if (Number.isFinite(mv)) {
                    out.push({
                        name: `${chip}:in${m[1]}`,
                        volts: Math.round(mv) / 1000,
                    });
                }
            }
        }
        return out;
    }

    protected async getOsInfo(): Promise<OsInfo> {
        const osr = await readFileSafe("/etc/os-release");
        const map: Record<string, string> = {};
        if (osr) {
            for (const line of osr.split("\n")) {
                const m = /^([A-Z_]+)=(.*)$/.exec(line);
                if (!m) continue;
                let v = m[2].trim();
                if (
                    (v.startsWith('"') && v.endsWith('"')) ||
                    (v.startsWith("'") && v.endsWith("'"))
                ) {
                    v = v.slice(1, -1);
                }
                map[m[1]] = v;
            }
        }
        const la = os.loadavg();
        return {
            platform: process.platform,
            distro: map.PRETTY_NAME || map.NAME || "Linux",
            version: map.VERSION_ID || map.VERSION || "",
            kernel: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
            uptimeSec: Math.round(os.uptime()),
            loadAvg: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
        };
    }

    /** Utility exposed to subclasses. */
    protected readFileSafe(p: string) {
        return readFileSafe(p);
    }
}
```

---

### 4.4 `providers/orange_pi_5_plus.ts`

```typescript
// client/modules/systeminfo/providers/orange_pi_5_plus.ts

import * as os from "node:os";
import { LinuxSystemInfoProvider } from "../base";
import { parseCpuinfo, IMPLEMENTERS, CPU_PART_MAP } from "../helpers";
import type { BoardInfo, CpuInfo, TemperatureSensor } from "../types";

/** Map RK3588 thermal zone types → friendly labels. */
const RK3588_LABELS: Record<string, string> = {
    "soc-thermal": "SoC",
    "bigcore0-thermal": "Big Core 0",
    "bigcore1-thermal": "Big Core 1",
    "littlecore-thermal": "Little Cores",
    "center-thermal": "Center",
    "gpu-thermal": "GPU",
    "npu-thermal": "NPU",
};

export class OrangePi5PlusSystemInfo extends LinuxSystemInfoProvider {
    async getBoardInfo(): Promise<BoardInfo> {
        const dt = (await this.readFileSafe("/proc/device-tree/model"))
            ?.replace(/\0/g, "")
            .trim();
        const ci = parseCpuinfo(
            (await this.readFileSafe("/proc/cpuinfo")) ?? "",
        );
        const model = dt || ci.fields["Hardware"] || "Orange Pi 5 Plus";
        return {
            model,
            vendor: "Xunlong",
            platformName: /RK3588/.test(model)
                ? "Orange Pi 5 Plus (RK3588)"
                : model,
        };
    }

    async getCpuInfo(): Promise<Omit<CpuInfo, "overallLoad" | "loadPerCore">> {
        const { cores, fields } = parseCpuinfo(
            (await this.readFileSafe("/proc/cpuinfo")) ?? "",
        );
        const soc = fields["Hardware"] ?? "Rockchip RK3588";
        const partName = CPU_PART_MAP[fields["CPU part"] ?? ""] ?? "";
        return {
            model: partName ? `${partName} (${soc})` : soc,
            manufacturer:
                IMPLEMENTERS[fields["CPU implementer"] ?? ""] ?? "ARM",
            architecture: os.arch(),
            cores,
            speedMHz: await this.getCpuSpeedMHz(),
        };
    }

    async getTemperatures(): Promise<TemperatureSensor[]> {
        return (await this.readSysfsThermalZones()).map((z) => ({
            ...z,
            label: RK3588_LABELS[z.type] ?? z.type,
        }));
    }

    // RK3588 has no userspace-visible throttling flags → base default (undefined) is correct.
}
```

---

### 4.5 `providers/raspberry_pi.ts`

```typescript
// client/modules/systeminfo/providers/raspberry_pi.ts

import * as os from "node:os";
import { $ } from "bun";
import { LinuxSystemInfoProvider } from "../base";
import { parseCpuinfo, CPU_PART_MAP } from "../helpers";
import type {
    BoardInfo,
    CpuInfo,
    TemperatureSensor,
    ThrottlingState,
} from "../types";

export class RaspberryPiSystemInfo extends LinuxSystemInfoProvider {
    /** Run `vcgencmd …` via Bun shell; returns stdout or null. */
    private async vcgencmd(args: string[]): Promise<string | null> {
        try {
            const cmd = ["vcgencmd", ...args];
            return await $`${cmd}`.quiet().text();
        } catch {
            return null;
        }
    }

    private async getVcgencmdGpuTemp(): Promise<number | null> {
        const out = await this.vcgencmd(["measure_temp"]);
        const m = out ? /temp=([\d.]+)/.exec(out) : null;
        return m ? parseFloat(m[1]) : null;
    }

    async getBoardInfo(): Promise<BoardInfo> {
        const dt = (await this.readFileSafe("/proc/device-tree/model"))
            ?.replace(/\0/g, "")
            .trim();
        const ci = parseCpuinfo(
            (await this.readFileSafe("/proc/cpuinfo")) ?? "",
        );
        return {
            model: dt || ci.fields["Model"] || "Raspberry Pi",
            vendor: "Raspberry Pi Foundation",
            platformName: "Raspberry Pi",
        };
    }

    async getCpuInfo(): Promise<Omit<CpuInfo, "overallLoad" | "loadPerCore">> {
        const { cores, fields } = parseCpuinfo(
            (await this.readFileSafe("/proc/cpuinfo")) ?? "",
        );
        const partName =
            CPU_PART_MAP[fields["CPU part"] ?? ""] ??
            fields["model name"] ??
            fields["CPU model"] ??
            "ARM";
        return {
            model: partName,
            manufacturer: "Broadcom",
            architecture: os.arch(),
            cores,
            speedMHz: await this.getCpuSpeedMHz(),
        };
    }

    async getTemperatures(): Promise<TemperatureSensor[]> {
        const zones = (await this.readSysfsThermalZones()).map((z) => ({
            ...z,
            label: /bcm|cpu|soc/i.test(z.type) ? "SoC" : z.type,
        }));
        const gpu = await this.getVcgencmdGpuTemp();
        if (gpu !== null) {
            zones.push({
                zone: "vcgencmd",
                type: "vcgencmd-gpu",
                label: "GPU",
                tempC: gpu,
            });
        }
        return zones;
    }

    protected async getThrottlingState(): Promise<ThrottlingState | undefined> {
        const out = await this.vcgencmd(["get_throttled"]);
        const m = out ? /throttled=(0x[0-9a-fA-F]+)/.exec(out) : null;
        if (!m) return undefined;
        const raw = parseInt(m[1], 16);
        return {
            underVoltage: (raw & 0x1) !== 0,
            armFreqCapped: (raw & 0x2) !== 0,
            currentlyThrottled: (raw & 0x4) !== 0,
            softTempLimit: (raw & 0x8) !== 0,
            raw,
        };
    }
}
```

---

### 4.6 `factory.ts`

```typescript
// client/modules/systeminfo/factory.ts

import { readFileSafe } from "./helpers";
import { LinuxSystemInfoProvider } from "./base";
import { OrangePi5PlusSystemInfo } from "./providers/orange_pi_5_plus";
import { RaspberryPiSystemInfo } from "./providers/raspberry_pi";

export async function createSystemInfoProvider(): Promise<LinuxSystemInfoProvider> {
    const dt =
        (await readFileSafe("/proc/device-tree/model"))
            ?.replace(/\0/g, "")
            .trim() ?? "";

    if (/Orange Pi 5 Plus/i.test(dt)) return new OrangePi5PlusSystemInfo();
    if (/Raspberry Pi/i.test(dt)) return new RaspberryPiSystemInfo();

    // Fallback via /proc/cpuinfo when device-tree is missing
    const ci = (await readFileSafe("/proc/cpuinfo")) ?? "";
    if (ci.includes("RK3588")) return new OrangePi5PlusSystemInfo();
    if (/\bBCM2\d{3}\b/.test(ci)) return new RaspberryPiSystemInfo();

    throw new Error(
        `Unsupported platform (device-tree model: "${dt || "n/a"}")`,
    );
}
```

---

### 4.7 `backend.ts`

```typescript
// client/modules/systeminfo/backend.ts

import type { BackendModule } from "../../../shared/contracts/backend_module";
import type { ModuleCore } from "../../backend/module_core";
import { createSystemInfoProvider } from "./factory";
import type { LinuxSystemInfoProvider } from "./base";

let core: ModuleCore | null = null;
let provider: LinuxSystemInfoProvider | null = null;
let providerError: string | null = null;

const mod: BackendModule = {
    kind: "device",
    id: "systeminfo",
    title: "System Info",
    // NO `roles` field → serves relay, encoder, obs, broadcaster.
    methods: ["systeminfo.get"],
    events: [],

    async start(ctx) {
        core = ctx.core;
        try {
            provider = await createSystemInfoProvider();
            const board = await provider.getBoardInfo();
            ctx.log("systeminfo", `Platform detected: ${board.platformName}`);
        } catch (e: any) {
            provider = null;
            providerError = String(e?.message ?? e);
            ctx.log("systeminfo", `Provider unavailable: ${providerError}`);
        }
    },

    async stop() {
        // Nothing to tear down.
    },

    async dispatch(method, params) {
        if (method !== "systeminfo.get") {
            throw new Error(`Unknown method: ${method}`);
        }
        if (!provider) {
            throw new Error(
                providerError ??
                    "System info provider not available on this platform",
            );
        }
        const { sampleMs } =
            (params as { sampleMs?: number } | undefined) ?? {};
        return await provider.getSystemInfo(sampleMs ?? 1000);
    },

    async status() {
        // Lightweight fragment — used by `available()` on the frontend card.
        return { platformSupported: provider !== null };
    },
};

export default mod;
```

---

### 4.8 `frontend.tsx` — **JSX form**

```tsx
// client/modules/systeminfo/frontend.tsx
// Uses JSX (jsxFactory: "m") — configure tsconfig as described in §3.1.
// ⚠️ Verify the RPC client path & the FrontendModule.component signature against
// your repo (see client/modules/network/frontend.tsx for reference).

import m from "mithril";
import type { FrontendModule } from "../../../shared/contracts/frontend_module";
import type { SystemInfo } from "./types";
import { rpc } from "../../services/rpc"; // ← adjust to the actual RPC client path
import "./styles.css";

const REFRESH_MS = 5_000;

/** Bytes → human-readable string. */
function fmt(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0,
        v = bytes;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(1)} ${units[i]}`;
}

/** Card component — returns an m.Component (lifecycle + view), body uses JSX. */
const SystemInfoView = (): m.Component => {
    let info: SystemInfo | null = null;
    let error: string | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchInfo = async () => {
        try {
            info = await rpc.call<SystemInfo>("systeminfo.get", {
                sampleMs: 1000,
            });
            error = null;
        } catch (e: any) {
            error = String(e?.message ?? e);
        }
        m.redraw();
    };

    return {
        oninit() {
            void fetchInfo();
        },
        oncreate() {
            timer = setInterval(fetchInfo, REFRESH_MS);
        },
        onremove() {
            if (timer) clearInterval(timer);
        },

        view() {
            if (error) {
                return (
                    <div class="systeminfo-card systeminfo-error">
                        ⚠ {error}
                    </div>
                );
            }
            if (!info) {
                return (
                    <div class="systeminfo-card">
                        Loading system information…
                    </div>
                );
            }

            const {
                board,
                os,
                cpu,
                memory,
                temperatures,
                throttling,
                filesystems,
                physicalDisks,
                network,
            } = info;

            const throttleMessages = throttling
                ? [
                      throttling.underVoltage && "⚡ undervoltage",
                      throttling.currentlyThrottled && "🔥 throttled",
                      throttling.armFreqCapped && "🐢 freq capped",
                      throttling.softTempLimit && "🌡 soft temp limit",
                  ]
                      .filter(Boolean)
                      .join(" · ") || "OK"
                : null;

            return (
                <div class="systeminfo-card">
                    <div class="systeminfo-header">
                        <strong>{board.model}</strong>
                        <span class="systeminfo-os">
                            {os.distro} · {os.kernel}
                        </span>
                    </div>

                    {/* ---- CPU ---- */}
                    <div class="systeminfo-section">
                        <h4>CPU</h4>
                        <div>
                            {cpu.model} · {cpu.cores} cores · {cpu.speedMHz} MHz
                        </div>
                        <div>Load: {cpu.overallLoad.toFixed(1)}%</div>
                        <div class="systeminfo-cores">
                            {cpu.loadPerCore.map((v, i) => (
                                <span class="systeminfo-core">
                                    C{i}: {v.toFixed(0)}%
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* ---- Temperatures ---- */}
                    <div class="systeminfo-section">
                        <h4>Temperatures</h4>
                        <div class="systeminfo-temps">
                            {temperatures.map((t) => (
                                <span class="systeminfo-temp">
                                    {t.label ?? t.type}: {t.tempC.toFixed(1)}°C
                                </span>
                            ))}
                        </div>
                        {throttling && (
                            <div
                                class={`systeminfo-throttle${throttling.currentlyThrottled ? " warn" : ""}`}>
                                {throttleMessages}
                            </div>
                        )}
                    </div>

                    {/* ---- Memory ---- */}
                    <div class="systeminfo-section">
                        <h4>Memory</h4>
                        <div>
                            {fmt(memory.usedBytes)} / {fmt(memory.totalBytes)}{" "}
                            used (
                            {(
                                (memory.usedBytes / memory.totalBytes) *
                                100
                            ).toFixed(1)}
                            %)
                        </div>
                    </div>

                    {/* ---- Disks ---- */}
                    <div class="systeminfo-section">
                        <h4>Disks</h4>
                        <table class="systeminfo-table">
                            <thead>
                                <tr>
                                    <th>Mount</th>
                                    <th>Type</th>
                                    <th>Used</th>
                                    <th>%</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filesystems.map((f) => (
                                    <tr>
                                        <td>{f.mount}</td>
                                        <td>{f.type}</td>
                                        <td>
                                            {fmt(f.usedBytes)} /{" "}
                                            {fmt(f.totalBytes)}
                                        </td>
                                        <td>{f.usePercent.toFixed(1)}%</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {physicalDisks.length > 0 && (
                            <table class="systeminfo-table">
                                <thead>
                                    <tr>
                                        <th>Disk</th>
                                        <th>R / W</th>
                                        <th>Util</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {physicalDisks.map((d) => (
                                        <tr>
                                            <td>{d.name}</td>
                                            <td>
                                                {fmt(d.readBytesPerSec)}/s ·{" "}
                                                {fmt(d.writeBytesPerSec)}/s
                                            </td>
                                            <td>
                                                {d.ioUtilization.toFixed(1)}%
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* ---- Network ---- */}
                    <div class="systeminfo-section">
                        <h4>Network</h4>
                        <table class="systeminfo-table">
                            <thead>
                                <tr>
                                    <th>Iface</th>
                                    <th>IP</th>
                                    <th>Rx / Tx</th>
                                </tr>
                            </thead>
                            <tbody>
                                {network
                                    .filter((n) => !n.internal)
                                    .map((n) => (
                                        <tr>
                                            <td>{n.iface}</td>
                                            <td>{n.ip4 ?? n.ip6 ?? "—"}</td>
                                            <td>
                                                {fmt(n.rxBytesPerSec ?? 0)}/s ·{" "}
                                                {fmt(n.txBytesPerSec ?? 0)}/s
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            );
        },
    };
};

const SystemInfoCard: FrontendModule = {
    kind: "device-card",
    id: "systeminfo",
    title: "System Info",
    order: 1000, // ← renders LAST, just before the log section
    defaultSize: { w: 4, h: 6 },
    minSize: { w: 3, h: 4 },
    available: (status) =>
        Boolean((status as any)?.systeminfo?.platformSupported),
    component: SystemInfoView,
};

export default SystemInfoCard;
```

> **Mithril JSX notes:**
>
> -   `class=` (not `className=`) is the correct attribute in Mithril JSX.
> -   Fragments (`<>…</>`) map to `m.Fragment` thanks to `"jsxFragmentFactory": "m.Fragment"` — used implicitly above where conditional blocks return `<div>` wrappers instead.
> -   Because the component's `view()` returns a `Vnode`, and JSX is compiled to `m(...)` calls by Bun, everything is one unified tree — Mithril lifecycle (`oninit`/`oncreate`/`onremove`) still fires as expected.
> -   If the actual `FrontendModule.component` type is `(status: Status) => m.Component` instead of `() => m.Component`, wrap: `component: (_status) => SystemInfoView()` — the handoff uses `() => m.Component` per §2, adjust if the contract differs.

---

### 4.9 `styles.css`

```css
/* client/modules/systeminfo/styles.css */

.systeminfo-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    font-size: 0.85rem;
    overflow: auto;
    height: 100%;
}

.systeminfo-card.systeminfo-error {
    color: #f87171;
}

.systeminfo-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.systeminfo-os {
    font-size: 0.75rem;
    opacity: 0.7;
}

.systeminfo-section h4 {
    margin: 0.5rem 0 0.25rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.75;
}

.systeminfo-cores,
.systeminfo-temps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    font-variant-numeric: tabular-nums;
}

.systeminfo-throttle.warn {
    color: #fbbf24;
    font-weight: 600;
}

.systeminfo-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
}

.systeminfo-table th,
.systeminfo-table td {
    padding: 0.15rem 0.4rem;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.systeminfo-table th {
    font-weight: 600;
    opacity: 0.7;
}
```

---

### 4.10 `i18n/en.json`

```json
{
    "systeminfo.title": "System Info"
}
```

> The core's i18n loader merges every module's `i18n/<lang>.json` automatically. If you later switch `frontend.tsx` from `title: "System Info"` to `t("systeminfo.title")`, add the `t` import once you verify its path (`shared/i18n/…` or `client/ui/i18n/…`).

---

## 5. Integration & Wiring Steps

Execute in order:

1. **Verify `tsconfig.json` (§3.1).** If `jsxFactory: "m"` isn't already set, add it. Confirm by checking that `client/modules/network/frontend.tsx` (or similar) already uses JSX without a pragma. If no JSX config exists anywhere and you're not allowed to edit root tsconfig, add `/** @jsx m */` + `/** @jsxFrag m.Fragment */` at the top of `frontend.tsx` (and any other `.tsx`).
2. **Create the directory tree** exactly as shown in §3.2.
3. **Create every file** with the source from §4.
4. **Adjust paths that may differ from assumptions** (grep for the real ones):
    - `shared/contracts/backend_module.ts`
    - `shared/contracts/frontend_module.ts`
    - `client/backend/module_core.ts`
    - RPC client (`shared/ui/services/rpc.ts` — search for `rpc.call` in an existing module)
5. **Regenerate manifests** (auto on `predev`/`prebuild`, but run manually for verification):
    ```bash
    bun run gen_modules   # if the script exists standalone
    # otherwise:
    bun run dev           # predev hook fires gen_modules
    ```
6. **Confirm the module appears in the generated registry** (`shared/registry.ts` or `client/modules/_generated.ts` — inspect the diff).
7. **Run the test suite**:
    ```bash
    bun test
    ```
    The registry test (`test/registries.test.ts`) must still pass.
8. **Smoke test on a device** (Orange Pi 5 Plus preferred) with each role:
    ```bash
    bun run dev --role relay
    bun run dev --role encoder
    bun run dev --role obs
    bun run dev --role broadcaster
    ```
    The card must render in every case.

---

## 6. Verification Checklist

| #   | Check                           | Pass criteria                                                                              |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | **Directory tree**              | `client/modules/systeminfo/` exists with all 10 files.                                     |
| 2   | **JSX configured**              | `tsconfig.json` has `jsx: "react"` + `jsxFactory: "m"` (or `frontend.tsx` has the pragma). |
| 3   | **TypeScript compiles**         | `bun run build` and `bunx tsc --noEmit` both succeed.                                      |
| 4   | **No new dependencies**         | `package.json` / `bun.lock` unchanged.                                                     |
| 5   | **Registry discovers module**   | Generated manifest lists `systeminfo`.                                                     |
| 6   | **All roles served**            | Card renders under `relay`, `encoder`, `obs`, `broadcaster`.                               |
| 7   | **Card is last before log**     | DOM order: `[… other cards …, systeminfo, log]`.                                           |
| 8   | **JSX renders correctly**       | No literal `<div>` strings in the DOM; conditional `throttling` block appears on RPi only. |
| 9   | **Data plausible (OPi 5 Plus)** | SoC temp 30–70 °C idle; ≥6 thermal sensors listed; NVMe shown if present.                  |
| 10  | **Data plausible (RPi)**        | `throttling` block shows _"OK"_ when idle; `vcgencmd` GPU temp included.                   |
| 11  | **Degrades gracefully**         | Kill `vcgencmd` (or run on OPi) — no crash; `throttling: undefined`.                       |
| 12  | **Tests pass**                  | `bun test` green.                                                                          |
| 13  | **Auto-refresh works**          | Values update every 5 s in the UI.                                                         |

---

## 7. Edge Cases & Known Behaviors

-   **Unsupported hardware** — `createSystemInfoProvider()` throws; `backend.ts` catches, logs once, and `systeminfo.get` returns an error. The card's `available()` returns `false` and hides itself.
-   **`vcgencmd` missing** — Silently returns `null`; only `throttling` is affected. **Do not** add a hard dependency.
-   **`df -B1 -T` on busybox** — Returns an error → `getFilesystems()` yields `[]`. Not fatal.
-   **`/sys/class/thermal/*/temp` permissions** — `readFileSafe` swallows the error; the sensor is just omitted.
-   **`overlay`/`tmpfs`/`squashfs`** — Filtered out of the filesystems list (see `SKIP_FS` in `base.ts`).
-   **NUL bytes in `/proc/device-tree/model`** — Stripped via `.replace(/\0/g, "")`.
-   **Sample window** — `getSystemInfo(1000)` blocks 1 s. If the frontend polls every 5 s, effective latency is ≤6 s. Acceptable; do not lower below 250 ms (noisy stats).
-   **JSX attribute names** — Mithril JSX uses `class` (not `className`), `for` (not `htmlFor`), and `onclick`/`oncreate` (lowercase, direct). Confirm `frontend.tsx` matches this — it does.
-   **No cycles** — `types ← helpers ← base ← providers ← factory ← backend`. **Do not** move `createSystemInfoProvider` into `backend.ts`.

---

## 8. References

| Resource                              | Purpose                                                               |
| ------------------------------------- | --------------------------------------------------------------------- |
| `client/modules/README.md`            | Module authoring guide                                                |
| `client/modules/ssh/backend.ts`       | Backend-only module example                                           |
| `client/modules/network/frontend.tsx` | Card module example — **check JSX config & component signature here** |
| `shared/contracts/backend_module.ts`  | Backend contract — verify fields                                      |
| `shared/contracts/frontend_module.ts` | Frontend contract — verify `component` signature                      |
| `scripts/gen_modules.ts`              | Discovery script — do not edit                                        |
| `test/registries.test.ts`             | Contract validation — must pass                                       |

---

## 9. Definition of Done

-   [ ] All 10 files from §3.2 exist with the content from §4.
-   [ ] JSX is configured (tsconfig `jsxFactory: "m"` or per-file pragma) and `frontend.tsx` uses JSX exclusively.
-   [ ] `bunx tsc --noEmit` clean.
-   [ ] `bun test` green.
-   [ ] Module discovered and card rendered in all 4 roles.
-   [ ] Card visually sits **after every other card** and **before the log**.
-   [ ] Temperature, memory, disk, and network figures are sane on **at least one real board** (Orange Pi 5 Plus or Raspberry Pi).
-   [ ] No files outside `client/modules/systeminfo/` are modified (except the one-line `tsconfig.json` JSX addition if it was missing).
-   [ ] No new entries in `package.json` dependencies.

When all boxes are checked, **open a single PR** titled `feat(modules): add systeminfo device module (OPi 5 Plus + Raspberry Pi, JSX frontend)` and link this handoff in the description.

---

_End of handoff._
