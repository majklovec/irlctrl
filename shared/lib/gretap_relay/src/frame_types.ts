/* Result type of `decodeFrame`. */
export type DecodedFrame =
    | { type: "data"; vifIp: string; payload: Uint8Array }
    | { type: "keepalive"; timestampMs: number }
    | { type: "malformed"; reason: string };
