/* The shape of a decoded wire frame (see protocol.ts). */
export type DecodedFrame =
    | { type: "data"; vifIp: string; payload: Uint8Array }
    | { type: "keepalive"; timestampMs: number }
    | { type: "malformed"; reason: string };
