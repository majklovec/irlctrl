// Generic Linux provider. Used for any board the factory cannot identify as
// an Orange Pi 5 Plus or a Raspberry Pi. Relies purely on the standard /proc
// and /sys interfaces, so it works on x86 and ARM alike; there is no
// board-specific throttling, so the base default (undefined) is left as-is.

import * as os from "node:os";
import { LinuxSystemInfoProvider } from "../base";
import { CPU_PART_MAP, IMPLEMENTERS, parseCpuinfo } from "../helpers";
import type { BoardInfo, CpuInfo, TemperatureSensor } from "../types";

const DMI_PLACEHOLDERS = new Set([
    "to be filled by o.e.m.",
    "system manufacturer",
    "default string",
    "unknown",
]);

export class LinuxGenericSystemInfo extends LinuxSystemInfoProvider {
    async getBoardInfo(): Promise<BoardInfo> {
        const dt = (await this.readFileSafe("/proc/device-tree/model"))
            ?.replace(/\0/g, "")
            .trim();
        const dmi = (await this.readFileSafe("/sys/class/dmi/id/sys_vendor"))
            ?.trim()
            .replace(/\0/g, "")
            .trim();
        const meaningful = (s: string | undefined): s is string =>
            !!s && !DMI_PLACEHOLDERS.has(s.toLowerCase());
        const vendor = dmi && meaningful(dmi) ? dmi : "Unknown";
        const model = dt || (dmi && meaningful(dmi) ? dmi : "Linux");
        return {
            model,
            vendor,
            platformName: dt ? model : "Linux",
        };
    }

    async getCpuInfo(): Promise<Omit<CpuInfo, "overallLoad" | "loadPerCore">> {
        const { cores, fields } = parseCpuinfo(
            (await this.readFileSafe("/proc/cpuinfo")) ?? "",
        );
        const vendorId = fields.vendor_id;
        let model: string;
        let manufacturer: string;
        if (vendorId) {
            // x86: `vendor_id` is one of GenuineIntel / AuthenticAMD.
            manufacturer = vendorId === "AuthenticAMD" ? "AMD" : "Intel";
            model = fields["model name"] || vendorId;
        } else {
            // ARM: derive from the implementer + part id.
            manufacturer =
                IMPLEMENTERS[fields["CPU implementer"] ?? ""] ?? "ARM";
            model =
                CPU_PART_MAP[fields["CPU part"] ?? ""] ||
                fields.Hardware ||
                "ARM";
        }
        return {
            model,
            manufacturer,
            architecture: os.arch(),
            cores,
            speedMHz: await this.getCpuSpeedMHz(),
        };
    }

    async getTemperatures(): Promise<TemperatureSensor[]> {
        // No board-specific zone labels — the zone type is the label.
        return (await this.readSysfsThermalZones()).map((z) => ({
            ...z,
            label: z.type,
        }));
    }
}
