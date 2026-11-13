/* Small stat-container helpers shared by both sides. */
import type { RelayStats, Stats, VifStats } from "./types";

export function newVifStats(): VifStats {
    return {
        txPackets: 0,
        txBytes: 0,
        rxPackets: 0,
        rxBytes: 0,
        txDropped: 0,
        rxDropped: 0,
        drops: 0,
    };
}

export function newRelayStats(): RelayStats {
    return {
        encRxPackets: 0,
        encRxBytes: 0,
        ifaceTxPackets: 0,
        ifaceTxBytes: 0,
        ifaceRxPackets: 0,
        ifaceRxBytes: 0,
        encTxPackets: 0,
        encTxBytes: 0,
        drops: 0,
        rxPackets: 0,
        rxBytes: 0,
        txPackets: 0,
        txBytes: 0,
    };
}

/** Record a non-fatal runtime error on a stats object (keeps the last one). */
export function noteError(
    stats: { lastError?: { at: number; message: string } },
    message: string,
): void {
    stats.lastError = { at: Date.now(), message };
}

/** Zero-filled counter bag. */
export function newStats(): Stats {
    return { rxBytes: 0, rxPackets: 0, txBytes: 0, txPackets: 0, drops: 0 };
}
