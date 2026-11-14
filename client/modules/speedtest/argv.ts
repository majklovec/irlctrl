/*
 * Argv construction for librespeed-cli — the single rule (speedtest.md §5.1):
 *
 *   librespeed-cli --json-stream
 *                 [--local-json <cachePath>]  // iff the cache file exists
 *                 [--server <serverId>]       // iff a specific server is picked
 *                 [--interface <ifaceName>]   // iff a specific interface is picked
 *
 * The cached server list is never filtered or rewritten per run; the choice
 * reaches the CLI only through `--server <id>`.
 */

export interface SpeedtestArgvOptions {
    /** Numeric server id from the list, null = "Auto" (omit `--server`). */
    serverId: number | null;
    /** Interface name to bind, null = "Auto" (omit `--interface`). */
    interface: string | null;
    /** Absolute cache path, and whether it exists on disk right now. */
    cachePath: string;
    cacheExists: boolean;
    /** Optional phase-duration override in seconds. */
    duration?: number | null;
}

/** Build the argument vector **after** the binary (the binary is separate). */
export function buildSpeedtestArgv(
    opts: SpeedtestArgvOptions,
): string[] {
    const argv = ["--json-stream"];
    if (opts.cacheExists) argv.push("--local-json", opts.cachePath);
    if (opts.serverId !== null && Number.isFinite(opts.serverId))
        argv.push("--server", String(opts.serverId));
    if (opts.interface) argv.push("--interface", opts.interface);
    if (opts.duration !== null && opts.duration !== undefined)
        argv.push("--duration", String(opts.duration));
    return argv;
}
