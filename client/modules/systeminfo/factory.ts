// Auto-detect the running board and build the matching provider. Detection
// prefers the device-tree model string and falls back to /proc/cpuinfo when
// the device-tree is absent (e.g. some containers).
//
// Lives here (not in backend.ts) so the provider tree stays a clean
// types ← helpers ← base ← providers ← factory ← backend dependency chain.

import { LinuxSystemInfoProvider } from "./base";
import { readFileSafe } from "./helpers";
import { LinuxGenericSystemInfo } from "./providers/linux_generic";
import { OrangePi5PlusSystemInfo } from "./providers/orange_pi_5_plus";
import { RaspberryPiSystemInfo } from "./providers/raspberry_pi";

export async function createSystemInfoProvider(): Promise<LinuxSystemInfoProvider> {
    const dt =
        (await readFileSafe("/proc/device-tree/model"))
            ?.replace(/\0/g, "")
            .trim() ?? "";

    if (/Orange Pi 5 Plus/i.test(dt)) return new OrangePi5PlusSystemInfo();
    if (/Raspberry Pi/i.test(dt)) return new RaspberryPiSystemInfo();

    // Fallback via /proc/cpuinfo when the device-tree is missing.
    const ci = (await readFileSafe("/proc/cpuinfo")) ?? "";
    if (ci.includes("RK3588")) return new OrangePi5PlusSystemInfo();
    if (/\bBCM2\d{3}\b/.test(ci)) return new RaspberryPiSystemInfo();

    // Unknown board: fall back to the generic provider, which reads the
    // standard /proc and /sys interfaces (x86 and ARM alike).
    return new LinuxGenericSystemInfo();
}
