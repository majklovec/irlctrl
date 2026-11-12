/*
 * MobLink encoder-side WebSocket SERVER (protocol.md §3: the encoder runs
 * the server, the relay connects as a client). Relays dial
 * `ws://<encoder-ip>:<wsPort>/moblink[?token=...]` and send their identity,
 * protocol version and the full uplink interface list (`hello`), plus
 * `interface_added` / `interface_removed` / `interface_up` / `interface_down`
 * events. The message shape + guard live in `shared/moblink_discovery.ts`
 * so both sides can never drift.
 *
 * The server is deliberately thin: it authenticates (optional token),
 * validates the messages, and hands them to the backend callback with the
 * connection's relay identity (learned from the first `hello`).
 */
import {
	isMoblinkRelayWsMessage,
	type MoblinkRelayWsMessage,
} from "../../../shared/moblink_discovery";

/** The WS path relays dial (fixed; the token is a query parameter). */
export const MOBLINK_RELAY_WS_PATH = "/moblink";

/** Per-connection state (the relay identity from its hello). */
export interface RelayWsConn {
	/** The relay identity (from the `hello`), once known. */
	relayId?: string;
	/** The relay's protocol version (from the `hello`), once known. */
	proto?: number;
}

interface Options {
	port: number;
	/** Expected token (empty = open, LAN-internal). */
	token: string;
	/** A validated relay → encoder message (the identity may be undefined
	 * until the relay's first `hello`). */
	onMessage: (conn: RelayWsConn, msg: MoblinkRelayWsMessage) => void;
	/** A relay connected and was accepted. */
	onOpen?: (conn: RelayWsConn) => void;
	/** A relay connection closed. */
	onClose?: (conn: RelayWsConn) => void;
}

/**
 * Start the relay WebSocket server on `port`. Returns the `Bun.Server` (for
 * `stop()` on config changes) or null on failure (the encoder keeps working
 * without the control channel — the UDP announce path is independent).
 */
export function startRelayWsServer(
	opts: Options,
): Bun.Server<RelayWsConn> | null {
	try {
		const server = Bun.serve<RelayWsConn>({
			port: opts.port,
			hostname: "0.0.0.0",
			fetch(req, srv): Response | undefined {
				const url = new URL(req.url);
				if (url.pathname !== MOBLINK_RELAY_WS_PATH)
					return new Response("not found", { status: 404 });
				if (opts.token !== "") {
					const given = url.searchParams.get("token") ?? "";
					if (given !== opts.token) {
						console.warn("moblink_streamer: rejecting relay WS — bad token");
						return new Response("unauthorized", { status: 401 });
					}
				}
				const conn: RelayWsConn = {};
				if (!srv.upgrade(req, { data: conn }))
					return new Response("websocket only", { status: 400 });
				opts.onOpen?.(conn);
				return undefined;
			},
			websocket: {
				open(ws) {
					const conn = ws.data as RelayWsConn;
					console.log(
						`moblink_streamer: relay WS connected${conn.relayId ? ` (${conn.relayId})` : ""}`,
					);
				},
				message(ws, msg) {
					let parsed: unknown;
					try {
						const text =
							typeof msg === "string"
								? msg
								: new TextDecoder().decode(
										// Bun types the binary frame as `Buffer<ArrayBuffer>`
										msg as unknown as ArrayBuffer,
									);
						parsed = JSON.parse(text);
					} catch {
						return; // not JSON — ignore
					}
					if (!isMoblinkRelayWsMessage(parsed)) {
						console.warn(
							"moblink_streamer: ignoring malformed relay WS message",
						);
						return;
					}
					const conn = ws.data;
					if (parsed.type === "hello") {
						conn.relayId = parsed.relay_id;
						conn.proto = parsed.proto;
					}
					opts.onMessage(conn, parsed);
				},
				close(ws) {
					const conn = ws.data;
					console.log(
						`moblink_streamer: relay WS closed${conn.relayId ? ` (${conn.relayId})` : ""}`,
					);
					opts.onClose?.(conn);
				},
			},
		});
		console.log(
			`moblink_streamer: relay WS server listening on 0.0.0.0:${server.port}${opts.token ? " (token auth)" : ""}`,
		);
		return server;
	} catch (e) {
		console.warn(
			`moblink_streamer: relay WS server failed to start: ${String(e)}`,
		);
		return null;
	}
}
