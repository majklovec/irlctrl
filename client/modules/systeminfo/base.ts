// The abstract Linux provider: a template method that samples /proc twice,
// sleeps the interval, then fans out every generic reader in parallel.
//
// Subclasses implement the three board-specific hooks (board / CPU /
// temperatures) and MAY override `getThrottlingState`. Everything that is the
// same across boards (memory, filesystems, disks, network, OS, fans) lives
// here so the providers stay tiny.

import * as os from "node:os";
import { $ } from "bun";
import {
    type CpuStatSample,
    computeCpuLoad,
    computeDiskIo,
    type DiskMeta,
    type DiskStatsEntry,
    listDir,
    readFileSafe,
} from "./helpers";
import type {
    BoardInfo,
    CpuInfo,
    FanSpeed,
    FilesystemInfo,
    MemoryInfo,
    NetworkInterfaceInfo,
    OsInfo,
    SystemInfo,
    TemperatureSensor,
    ThrottlingState,
    Voltage,
} from "./types";

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

    /** Public template method: one sampled `SystemInfo`. */
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
        let sum = 0;
        let n = 0;
        for (const e of entries) {
            if (!/^cpu\d+$/.test(e)) continue;
            const raw = await readFileSafe(
                `/sys/devices/system/cpu/${e}/cpufreq/scaling_cur_freq`,
            );
            if (raw) {
                const mhz = parseInt(raw, 10) / 1000;
                if (Number.isFinite(mhz)) {
                    sum += mhz;
                    n++;
                }
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
            const idle = nums[3] ?? 0;
            const iowait = nums[4] ?? 0;
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
        const total = toB(kv.MemTotal);
        const free = toB(kv.MemFree);
        const available = toB(kv.MemAvailable) || free;
        const swapTotal = toB(kv.SwapTotal);
        const swapFree = toB(kv.SwapFree);
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

    private static readonly SKIP_FS = new Set([
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
            if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) continue;
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
            const ip4 = addrs.find((x) => x.family === "IPv4")?.address;
            const ip6 = addrs.find((x) => x.family === "IPv6")?.address;
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

            let rxBytesPerSec: number | undefined;
            let txBytesPerSec: number | undefined;
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
                if (Number.isFinite(mv))
                    out.push({
                        name: `${chip}:in${m[1]}`,
                        volts: Math.round(mv) / 1000,
                    });
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
                )
                    v = v.slice(1, -1);
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

    /** Convenience alias so subclasses can call `this.readFileSafe(...)`. */
    protected readFileSafe(p: string) {
        return readFileSafe(p);
    }
}
