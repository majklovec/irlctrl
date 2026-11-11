/*
 * MobLink encoder-side discovery (receiver). Binds
 * `0.0.0.0:MOBLINK_DISCOVERY_PORT` (reuseAddr so several listeners can
 * coexist), parses `MoblinkAnnounce` datagrams from any relay on the LAN, and
 * maintains a TTL'd registry of the relays we hear. `onChange` fires when the
 * registry's shape changes (a relay appears, disappears, or its interface list
 * changes) so the streamer backend can reconcile its per-interface TUNs (spec
 * 100-moblink §5, §6.3).
 *
 * Uses `node:dgram` for a stable API across Bun versions. Independent of the
 * control server: this is pure LAN UDP.
 */
import dgram from "node:dgram";
import {
    isMoblinkAnnounce,
    MOBLINK_ANNOUNCE_TTL_MS,
    MOBLINK_DISCOVERY_PORT,
    type MoblinkDiscoveredRelay,
} from "../../../shared/moblink_discovery";

let socket: dgram.Socket | undefined;
let sweeper: ReturnType<typeof setInterval> | undefined;
let relays = new Map<string, MoblinkDiscoveredRelay>();
let lastSig = "";
let onChange: ((relays: MoblinkDiscoveredRelay[]) => void) | undefined;

function signature(): string {
    const out: string[] = [];
    for (const [host, r] of [...relays].sort((a, b) =>
        a[0].localeCompare(b[0]),
    )) {
        out.push(
            `${host}|${r.interfaces
                .map((i) => `${i.name}:${i.address}:${i.listenPort}`)
                .join(",")}`,
        );
    }
    return out.join(";");
}

/** Compact one-line summary of a relay's shared interfaces (debug logs). */
function endpointSummary(eps: MoblinkDiscoveredRelay["interfaces"]): string {
    return eps
        .map((e) => `${e.name}: ${e.address} | ${e.listenPort}`)
        .join(", ");
}

/** Fire `onChange` only when the registry shape changed since the last emit. */
function emitIfChanged(): void {
    const sig = signature();
    if (sig !== lastSig) {
        lastSig = sig;
        console.log(
            `moblink_streamer: discovered relays: ${relays.size} ${[
                ...relays.values(),
            ]
                .map((r) => `${r.host} [${endpointSummary(r.interfaces)}]`)
                .join(" | ")}`,
        );
        try {
            onChange?.([...relays.values()]);
        } catch {
            /* a consumer error must not kill the listener */
        }
    }
}

/**
 * Start listening for relay announces; `onChange(relays)` fires on every
 * shape change. Returns the current (known) relays.
 */
export function startDiscovering(
    onChangeCb: (relays: MoblinkDiscoveredRelay[]) => void,
    opts: { dryRun?: boolean } = {},
): MoblinkDiscoveredRelay[] {
    stopDiscovering();
    onChange = onChangeCb;
    if (opts.dryRun) {
        console.log("moblink_streamer: discovery listen skipped (dry-run)");
        return [...relays.values()];
    }
    try {
        const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
        s.on("error", (e) =>
            console.warn(
                `moblink_streamer: discovery socket error: ${e.message}`,
            ),
        );
        s.on("message", (msg: Buffer): void => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(msg.toString());
            } catch {
                return; // not JSON — ignore
            }
            if (!isMoblinkAnnounce(parsed)) return;
            relays.set(parsed.host, {
                host: parsed.host,
                hostname: parsed.hostname,
                interfaces: parsed.interfaces,
                lastSeen: Date.now(),
            });
            console.log(
                `moblink_streamer: registered relay ${parsed.host}${parsed.hostname ? ` (${parsed.hostname})` : ""} ifaces=[${endpointSummary(parsed.interfaces)}]`,
            );
            emitIfChanged();
        });
        s.bind(MOBLINK_DISCOVERY_PORT, "0.0.0.0");
        socket = s;
        console.log(
            `moblink_streamer: discovery listen started on 0.0.0.0:${MOBLINK_DISCOVERY_PORT}`,
        );
    } catch (e) {
        console.warn(`moblink_streamer: discovery listen failed: ${String(e)}`);
    }
    // Periodic TTL sweep: drop relays we stopped hearing.
    const sweep = setInterval(() => {
        const now = Date.now();
        const swept: string[] = [];
        for (const [host, r] of relays) {
            if (now - r.lastSeen > MOBLINK_ANNOUNCE_TTL_MS) {
                relays.delete(host);
                swept.push(host);
            }
        }
        if (swept.length > 0) {
            console.log(
                `moblink_streamer: swept stale relay(s): ${swept.join(", ")}`,
            );
            emitIfChanged();
        }
    }, MOBLINK_ANNOUNCE_TTL_MS / 3);
    // Don't keep the process alive solely for discovery.
    sweep.unref?.();
    sweeper = sweep;
    return [...relays.values()];
}

/**
 * Register a relay as if its announce had just been received. This is the
 * control-server registration path (a relay can hand the encoder its IP
 * through the control plane instead of UDP) and is also what tests use to
 * seed a discovered relay. Fires the change callback on a shape change.
 */
export function noteRelay(relay: MoblinkDiscoveredRelay): void {
    console.log(
        `moblink_streamer: registered relay (control-server) ${relay.host}${relay.hostname ? ` (${relay.hostname})` : ""} ifaces=[${endpointSummary(relay.interfaces)}]`,
    );
    relays.set(relay.host, { ...relay, lastSeen: Date.now() });
    emitIfChanged();
}

/** A registry entry for host (if known); null otherwise. */
export function getKnownRelay(host: string): MoblinkDiscoveredRelay | null {
    return relays.get(host) ?? null;
}

/** The currently-known relays (empty when none heard). */
export function knownRelays(): MoblinkDiscoveredRelay[] {
    return [...relays.values()];
}

/**
 * Stop listening and clear the learned-relay registry. Discovered relays are
 * transient LAN state — they are re-learned from the next announce on start
 * — so clearing here gives a clean slate (and clean per-run state).
 */
export function stopDiscovering(): void {
    const had = sweeper !== undefined || socket !== undefined;
    const known = relays.size;
    if (sweeper) {
        clearInterval(sweeper);
        sweeper = undefined;
    }
    const s = socket;
    socket = undefined;
    if (had)
        console.log(
            `moblink_streamer: discovery listen stopped (dropped ${known} known relay(s))`,
        );
    if (s) {
        try {
            s.close();
        } catch {
            /* already closed */
        }
    }
    relays = new Map();
    lastSig = "";
}
