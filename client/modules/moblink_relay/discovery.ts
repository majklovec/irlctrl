/*
 * MobLink relay → encoder discovery (sender side). When a relay runs, it
 * periodically broadcasts a small JSON `MoblinkAnnounce` over UDP to the
 * limited-broadcast address (255.255.255.255) on the fixed well-known
 * `MOBLINK_DISCOVERY_PORT` (spec 100-moblink §5, extension to the v1
 * single-relay module). Encoders listening on that port learn the relay's
 * shared tunnel interfaces without any control server and without the user
 * having to type the relay's IP.
 *
 * Uses `node:dgram` (Bun's `Bun.udp` does not expose `SO_BROADCAST` in 1.4.4):
 * the sender socket is bound, `setBroadcast(true)` is set, and the announce is
 * re-sent on an interval so encoder-side TTL entries stay fresh. `buildPayload`
 * is called every tick so the announce always reflects the live interface set.
 */
import dgram from "node:dgram";
import {
    MOBLINK_ANNOUNCE_INTERVAL_MS,
    MOBLINK_BROADCAST_ADDR,
    MOBLINK_DISCOVERY_PORT,
    type MoblinkAnnounce,
} from "../../../shared/moblink_discovery";

/** The bound UDP socket used to broadcast announce datagrams. */
let socket: dgram.Socket | undefined;
/** The re-broadcast timer. */
let timer: ReturnType<typeof setInterval> | undefined;

/** Compact one-line summary of an announce's shared interfaces (debug logs). */
function endpointSummary(eps: MoblinkAnnounce["interfaces"]): string {
    return eps
        .map((e) => `${e.name}: ${e.address} | ${e.listenPort}`)
        .join(", ");
}

function sendOnce(s: dgram.Socket, announce: MoblinkAnnounce): void {
    console.log(
        `moblink_relay: advertising host=${announce.host} ifaces=[${endpointSummary(announce.interfaces)}] → ${MOBLINK_BROADCAST_ADDR}:${MOBLINK_DISCOVERY_PORT}`,
    );
    try {
        s.send(
            JSON.stringify(announce),
            MOBLINK_DISCOVERY_PORT,
            MOBLINK_BROADCAST_ADDR,
            (e) => {
                if (e)
                    console.warn(
                        `moblink_relay: discovery announce failed: ${e.message}`,
                    );
            },
        );
    } catch (e) {
        console.warn(`moblink_relay: discovery announce failed: ${String(e)}`);
    }
}

/** Start broadcasting `buildPayload()` announcements until `stopAnnouncing`. */
export function startAnnouncing(
    buildPayload: () => MoblinkAnnounce | null,
    opts: { dryRun?: boolean } = {},
): void {
    stopAnnouncing();
    if (opts.dryRun) {
        console.log("moblink_relay: discovery advertise skipped (dry-run)");
        return;
    }
    try {
        const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
        s.on("error", (e) =>
            console.warn(`moblink_relay: discovery socket error: ${e.message}`),
        );
        const begin = (): void => {
            try {
                s.setBroadcast(true);
            } catch {
                /* best-effort — unicast encoders on the same host still work */
            }
            console.log(
                `moblink_relay: discovery advertise started → ${MOBLINK_BROADCAST_ADDR}:${MOBLINK_DISCOVERY_PORT} every ${MOBLINK_ANNOUNCE_INTERVAL_MS}ms`,
            );
            const tick = (): void => {
                const announce = buildPayload();
                if (announce) sendOnce(s, announce);
            };
            tick();
            timer = setInterval(tick, MOBLINK_ANNOUNCE_INTERVAL_MS);
            timer.unref?.();
        };
        // Bind the socket to the announce host so the limited-broadcast
        // (255.255.255.255) egresses on the interface facing the encoders.
        // An unbound socket routes the broadcast out the default-route
        // interface, which may be a different subnet than the one encoders
        // actually reach the relay tunnels on (e.g. interconnect-only NIC).
        const bindHost = buildPayload()?.host ?? "";
        if (bindHost) s.bind(0, bindHost, begin);
        else s.bind(0, begin);
        socket = s;
    } catch (e) {
        console.warn(
            `moblink_relay: discovery announce failed to start: ${String(e)}`,
        );
        stopAnnouncing();
    }
}

/** Stop broadcasting; best-effort (never throws). */
export function stopAnnouncing(): void {
    const had = timer !== undefined || socket !== undefined;
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
    const s = socket;
    socket = undefined;
    if (had) console.log("moblink_relay: discovery advertise stopped");
    if (s) {
        try {
            s.close();
        } catch {
            /* already closed */
        }
    }
}
