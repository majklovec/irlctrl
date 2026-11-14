/*
 * Speedtest wire shapes. The `speedtest.run` event carries a live envelope
 * (one per CLI NDJSON line), the RPC methods carry the payloads below.
 * Results are in-memory only: nothing here is persisted.
 */

/** One LibreSpeed server, normalized for the dropdown (id + display fields). */
export interface SpeedtestServer {
    id: number;
    name: string;
    sponsor: string;
    url: string;
}

/** The server-list payload: `available` is false when a fetch failed and no
 * cache exists (the UI then offers only "Auto"). */
export interface SpeedtestServers {
    available: boolean;
    servers: SpeedtestServer[];
    /** Epoch ms of the on-disk cache, null when there is no cache. */
    cachedAt: number | null;
    /** A background refresh is in flight. */
    refreshing: boolean;
}

/** One host network interface (from /sys/class/net joined with os info). */
export interface SpeedtestInterface {
    name: string;
    addresses: string[];
    up: boolean;
}

/** A librespeed-cli report object (the `reports[0]` of a result event). */
export interface SpeedtestReport {
    timestamp: string;
    server: { name: string; url: string };
    client: {
        ip: string;
        hostname: string;
        city: string;
        region: string;
        country: string;
        loc: string;
        postal: string;
        timezone: string;
        org: string;
    };
    bytes_sent: number;
    bytes_received: number;
    ping: number;
    jitter: number;
    upload: number;
    download: number;
    share: string;
    tls?: { version: string; cipher: string };
}

/**
 * The live event envelope pushed on the `speedtest.run` event — one per
 * parsed CLI NDJSON line, plus a synthetic `error` and a final `exit`.
 * `kind: "result"` always precedes `kind: "exit"`.
 */
export type SpeedtestRunKind =
    | "phase"
    | "progress"
    | "result"
    | "error"
    | "exit";

export type SpeedtestRunEvent =
    | { runId: string; kind: "phase"; data: { event: "phase"; phase: string } }
    | {
          runId: string;
          kind: "progress";
          data: {
              event: "progress";
              phase: string;
              seconds: number;
              mbps: number;
              progress: number;
          };
      }
    | { runId: string; kind: "result"; data: { event: "result"; reports: SpeedtestReport[] } }
    | {
          runId: string;
          kind: "error";
          data: { message: string; exitCode: number | null; stderrTail: string };
      }
    | { runId: string; kind: "exit"; data: { code: number | null } };

/** The in-memory last result (cleared on process restart; no persistence). */
export interface SpeedtestLast {
    runId: string;
    interface: string | null;
    serverId: number | null;
    serverName: string | null;
    startedAt: string;
    finishedAt: string;
    result: SpeedtestReport;
}
