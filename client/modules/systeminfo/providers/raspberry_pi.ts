// Raspberry Pi (BCM2711 / BCM2712 / BCM2837) provider. Beyond the standard
// sysfs thermal zones it reads the GPU temperature and the throttling flags
// from `vcgencmd`, which no other board exposes.

import * as os from "node:os";
import { $ } from "bun";
import { LinuxSystemInfoProvider } from "../base";
import { CPU_PART_MAP, parseCpuinfo } from "../helpers";
import type {
    BoardInfo,
    CpuInfo,
    TemperatureSensor,
    ThrottlingState,
} from "../types";

export class RaspberryPiSystemInfo extends LinuxSystemInfoProvider {
    /** Run `vcgencmd <args>` via Bun's shell; returns trimmed stdout or null. */
    private async vcgencmd(args: string[]): Promise<string | null> {
        try {
            return (await $`vcgencmd ${args}`.quiet().text()).trim();
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
            model: dt || ci.fields.Model || "Raspberry Pi",
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
        if (gpu !== null)
            zones.push({
                zone: "vcgencmd",
                type: "vcgencmd-gpu",
                label: "GPU",
                tempC: gpu,
            });
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
