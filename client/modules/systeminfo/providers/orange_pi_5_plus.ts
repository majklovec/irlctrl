// Orange Pi 5 Plus (RK3588) provider. The RK3588 exposes its thermal zones and
// cpufreq through the standard sysfs interfaces, so only the board identity,
// the CPU core naming and the zone labels are board-specific.

import * as os from "node:os";
import { LinuxSystemInfoProvider } from "../base";
import { CPU_PART_MAP, IMPLEMENTERS, parseCpuinfo } from "../helpers";
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
        const model = dt || ci.fields.Hardware || "Orange Pi 5 Plus";
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
        const soc = fields.Hardware ?? "Rockchip RK3588";
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

    // The RK3588 has no userspace-visible throttling flags — the base default
    // (undefined) is correct.
}
