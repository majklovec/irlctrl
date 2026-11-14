/*
 * Instantaneous throughput from the CLI's cumulative Mbps (spec §7.3): the
 * CLI reports a running average that visibly decays, so the card's big number
 * shows the cumulative value and the sparkline shows per-second deltas.
 */

export interface CumFrame {
    mbps: number;
    seconds: number;
}

/** Instant Mbps between two cumulative frames; clamps negative/NaN → 0. */
export function instantMbps(
    prev: CumFrame | null,
    cur: CumFrame,
): number {
    if (!prev) return 0;
    const dt = cur.seconds - prev.seconds;
    if (dt <= 0) return 0;
    const inst = (cur.mbps * cur.seconds - prev.mbps * prev.seconds) / dt;
    return Number.isFinite(inst) && inst > 0 ? inst : 0;
}
