/*
 * NDJSON stream parsing for librespeed-cli `--json-stream` output.
 *
 * The child's stdout is newline-delimited JSON, but a chunk boundary may split
 * a line (partial trailing line at exit) and non-JSON noise (banner lines)
 * can appear. `NdjsonParser` buffers the tail, counts garbage in a debug
 * counter, and hands back only well-shaped events.
 */
import type { SpeedtestReport } from "./types";

/** A validated CLI event, ready for the broadcast envelope. */
export type SpeedtestCliEvent =
    | { event: "phase"; phase: string }
    | {
          event: "progress";
          phase: string;
          seconds: number;
          mbps: number;
          progress: number;
      }
    | { event: "result"; reports: SpeedtestReport[] };

/** Feed bytes/strings; returns the events completed by this chunk. */
export class NdjsonParser {
    private buffer = "";
    /** Lines that failed JSON.parse (banner noise, partial tail at flush). */
    public garbage = 0;

    /** Append a chunk of decoded stdout text. */
    push(chunk: string): SpeedtestCliEvent[] {
        this.buffer += chunk;
        const events: SpeedtestCliEvent[] = [];
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            const event = parseLine(line);
            if (event) events.push(event);
            else if (line) this.garbage++;
        }
        return events;
    }

    /** Discard the incomplete trailing line (called at process exit). */
    flush(): SpeedtestCliEvent[] {
        const tail = this.buffer.trim();
        this.buffer = "";
        if (!tail) return [];
        const event = parseLine(tail);
        this.garbage += event ? 0 : 1;
        return event ? [event] : [];
    }
}

/** Parse one NDJSON line into a validated event; null for noise. */
export function parseLine(line: string): SpeedtestCliEvent | null {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof raw !== "object" || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    switch (obj.event) {
        case "phase":
            if (typeof obj.phase !== "string") return null;
            return { event: "phase", phase: obj.phase };
        case "progress":
            if (
                typeof obj.phase !== "string" ||
                typeof obj.seconds !== "number" ||
                typeof obj.mbps !== "number" ||
                typeof obj.progress !== "number"
            )
                return null;
            return {
                event: "progress",
                phase: obj.phase,
                seconds: obj.seconds,
                mbps: obj.mbps,
                progress: obj.progress,
            };
        case "result": {
            if (!Array.isArray(obj.reports) || obj.reports.length === 0)
                return null;
            const first = obj.reports[0] as Record<string, unknown>;
            if (
                typeof first !== "object" ||
                first === null ||
                typeof first.download !== "number" ||
                typeof first.upload !== "number"
            )
                return null;
            return { event: "result", reports: obj.reports as SpeedtestReport[] };
        }
        default:
            return null;
    }
}
