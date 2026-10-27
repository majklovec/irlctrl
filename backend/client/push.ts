/*
 * Server → client pushes shared by the local WebSocket API and the remote
 * control link: `status` (debounced, deduplicated), `log`, and module events
 * (`ctx.emit`) — optionally throttled per sink and/or retained for replay to
 * new connections.
 */

import type { LogEvent } from "../../shared/logMessages";
import type { EmitOptions } from "../../shared/module-contract";
import { errorMessage } from "../../shared/util";
import { logEntries, onLogEntry } from "./eventlog";
import { buildStatus } from "./methods";
import { onStateChange } from "./state";

const BROADCAST_DEBOUNCE_MS = 250;
// Throttled sources push about once a second; allow for jitter so a 2 s interval is not every 3 s
const THROTTLE_JITTER_MS = 250;

export interface StatusSink {
    /** Whether anyone is listening right now (skip building status otherwise). */
    active(): boolean;
    send(msg: string): void;
    /** Minimum spacing of throttled module pushes (0 = every update, negative = never). */
    throttleMs?: number;
}

interface Frame {
    type: "event";
    event: string;
    data: unknown;
    /** Set on module-generated pushes so clients can route them. */
    module?: string;
    /** Replayed to new connections (control server viewers too). */
    retain?: true;
    /** Device-list summary fields (control server). */
    summary?: Record<string, unknown>;
}

const frame = (f: Frame): string => JSON.stringify(f);

export const statusEvent = async (): Promise<string> =>
    frame({ type: "event", event: "status", data: await buildStatus() });

/** Full event log, sent to every new connection. */
export const logHistoryEvent = (): string =>
    frame({
        type: "event",
        event: "log",
        data: { reset: true, entries: logEntries() } satisfies LogEvent,
    });

const sinks = new Map<StatusSink, Map<string, number>>(); // sink → event → last throttled push
const retained = new Map<string, string>(); // event → last retained frame
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lastBroadcast = "";

const activeSinks = () => [...sinks.keys()].filter((s) => s.active());

/** Retained module frames a newly connected sink should receive. */
export const retainedEvents = (sink?: StatusSink): string[] =>
    (sink?.throttleMs ?? 0) < 0 ? [] : [...retained.values()];

function scheduleBroadcast(): void {
    if (broadcastTimer || !activeSinks().length) return;
    broadcastTimer = setTimeout(async () => {
        broadcastTimer = null;
        try {
            const msg = await statusEvent();
            if (msg === lastBroadcast) return;
            lastBroadcast = msg;
            for (const sink of activeSinks()) sink.send(msg);
        } catch (err: unknown) {
            console.error("Status broadcast failed:", errorMessage(err));
        }
    }, BROADCAST_DEBOUNCE_MS);
}

/**
 * Push a module-generated event, tagged with the module id. Throttled events
 * honour each sink's `throttleMs`; retained events are replayed to new
 * connections (a push with `retain: false` drops the retained frame).
 */
export function pushModuleEvent(
    event: string,
    data: unknown,
    module: string,
    opts: EmitOptions = {},
): void {
    const msg = frame({
        type: "event",
        event,
        data,
        module,
        ...(opts.retain ? { retain: true } : {}),
        ...(opts.summary ? { summary: opts.summary } : {}),
    });
    if (opts.retain) retained.set(event, msg);
    else if (opts.retain === false) retained.delete(event);
    const now = Date.now();
    for (const sink of activeSinks()) {
        if (opts.throttle) {
            const interval = sink.throttleMs ?? 0;
            if (interval < 0) continue;
            const last = sinks.get(sink)?.get(event) ?? 0;
            if (interval > 0 && now - last < interval - THROTTLE_JITTER_MS)
                continue;
            sinks.get(sink)?.set(event, now);
        }
        sink.send(msg);
    }
}

let subscribed = false;

/** Register a push target; returns an unregister function. */
export function addStatusSink(sink: StatusSink): () => void {
    sinks.set(sink, new Map());
    if (!subscribed) {
        subscribed = true;
        onStateChange(scheduleBroadcast);
        onLogEntry((entry) => {
            const msg = frame({
                type: "event",
                event: "log",
                data: { entries: [entry] } satisfies LogEvent,
            });
            for (const s of activeSinks()) s.send(msg);
        });
    }
    return () => void sinks.delete(sink);
}
