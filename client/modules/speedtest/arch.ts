/*
 * Release-asset arch mapping for the librespeed-cli auto-download
 * (speedtest.md §5.2 / acceptance: x86_64 and ARM incl. armv6l).
 *
 * `process.arch` is not fine-grained enough for 32-bit ARM (it says `arm`
 * for armv6l/armv7l alike), so the mapping keys on `uname -m` output.
 */

/** `uname -m` value → Go asset arch token of the release. Throws on unknown. */
export function linuxArchAsset(uname: string): string {
    switch (uname) {
        case "x86_64":
            return "amd64";
        case "i686":
        case "i386":
            return "386";
        case "aarch64":
            return "arm64";
        // 32-bit userland on ARMv8 HW: the arm64 asset will not exec there.
        case "armv8l":
        case "armv7l":
            return "armv7";
        case "armv6l":
            return "armv6";
        default:
            throw new Error(`unsupported architecture: ${uname}`);
    }
}
