/** @jsx m */

/*
 * The WebRTC element: a rectangle that shows a live remote camera/screen feed.
 * Each instance carries its own `streamId` (generated on create via
 * `createProps`, so no two elements share a stream). The edit form shows the
 * sender URL the owner shares with a phone; the page at that URL dials the
 * control server's signaling WebSocket as `sender` and publishes its media.
 *
 * The receiver connects in BOTH the editor (live preview) and the runtime page.
 * Any number of receivers may watch one stream at once: the OBS runtime page is
 * the `priority` receiver (its context carries `activeTriggers`, which only the
 * runtime builds) and carries the live media. Every other concurrent receiver
 * is a `shadow`: it keeps its last frame and shows a note that the overlay has
 * the live feed, without a peer connection of its own. When the primary leaves,
 * the newest remaining receiver is promoted and the sender renegotiates with it.
 * The hint text shows while this receiver is active and no sender has the feed.
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { bindableForm } from "@ui/overlay/fields";
import { uuid } from "@ui/util";
import type { Vnode } from "mithril";
import m from "mithril";
import QRCode from "qrcode";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

export interface WebrtcProps {
	/** Auto-generated per instance; not user-editable. Seeds the sender URL. */
	streamId: string;
}

export const DEFAULT_WEBRTC_PROPS: Required<WebrtcProps> = {
	streamId: "",
};

/**
 * The default ICE servers (STUN only), used before the server's `room-state`
 * teaches this receiver the deployment's servers (STUN + the minted TURN, when
 * configured). The servers are adopted from every room-state snapshot, so the
 * peer always negotiates with the same set the sender uses.
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
	{ urls: "stun:stun.l.google.com:19302" },
];

interface ReceiverState {
	/** The live peer connection; null while this receiver is a shadow. */
	pc: RTCPeerConnection | null;
	ws: WebSocket;
	video: HTMLVideoElement;
	/** The "Waiting for a sender" hint; hidden while media lands or shadowed. */
	hint: HTMLSpanElement | null;
	/** The "the overlay has the live feed" note; shown only when shadowed. */
	note: HTMLSpanElement | null;
	/** True when this is the OBS runtime page (claims the live receiver slot). */
	priority: boolean;
	/** True while this receiver is a non-active shadow (note + last frame). */
	shadow: boolean;
	/** True once a remote track of the CURRENT peer has been rendered. */
	hasTrack: boolean;
}

/** One live receiver per stream id (a stream's receiver re-attach is a no-op). */
const receivers = new Map<string, ReceiverState>();

/**
 * The signaling WebSocket for a stream id. The route is shared by sender and
 * receiver; the role is a query param read by the server on upgrade (no
 * `join` frame). A `priority` receiver (the OBS runtime page) additionally
 * claims the live-media receiver slot, demoting any concurrent shadow.
 */
function signalingUrl(streamId: string, priority: boolean): string {
	const suffix = priority ? "&priority=1" : "";
	return (
		(location.protocol === "https:" ? "wss://" : "ws://") +
		location.host +
		`/api/webrtc/stream/${encodeURIComponent(streamId)}/ws?role=receiver` +
		suffix
	);
}

/** Open the signaling socket and drive the answerer / shadow state machine. */
function attachReceiver(
	streamId: string,
	video: HTMLVideoElement,
	hint: HTMLSpanElement | null,
	note: HTMLSpanElement | null,
	priority: boolean,
): ReceiverState {
	const state: ReceiverState = {
		pc: null,
		ws: null as unknown as WebSocket,
		video,
		hint,
		note,
		priority,
		// The first room-state (the `sync` reply) is the authority; this only
		// seeds the pre-layout moment (the hint, "waiting for a sender").
		shadow: false,
		hasTrack: false,
	};

	const setDisplay = (el: HTMLElement | null, display: string): void => {
		if (el) el.style.display = display;
	};
	const showHint = () => setDisplay(state.hint, "");
	const hideHint = () => setDisplay(state.hint, "none");
	const showNote = () => setDisplay(state.note, "flex");
	const hideNote = () => setDisplay(state.note, "none");
	// Before the first room-state, the note is hidden and the hint is shown.
	hideNote();

	let pendingCandidates: RTCIceCandidateInit[] = [];
	// The room's ICE servers (STUN + the server's minted TURN, when set).
	// Adopted from each `room-state` snapshot before the peer is created; STUN
	// only until the first snapshot with servers arrives.
	let iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
	let chain: Promise<void> = Promise.resolve();
	const enqueue = (fn: () => Promise<void>): void => {
		chain = chain
			.then(fn)
			.catch((err) =>
				console.error(
					`[webrtc] receiver signaling frame failed (stream ${streamId})`,
					err,
				),
			);
	};
	const flushCandidates = async () => {
		const queue = pendingCandidates;
		pendingCandidates = [];
		const pc = state.pc;
		if (!pc) return;
		// a candidate that fails here is stale (a re-negotiation replaced the
		// peer's state); drop it silently
		for (const candidate of queue) {
			try {
				await pc.addIceCandidate(candidate);
			} catch {
				/* stale */
			}
		}
	};

	/** The live peer, created lazily when this receiver becomes active. */
	const ensurePeer = (): RTCPeerConnection => {
		const existing = state.pc;
		if (existing) return existing;
		const ws = state.ws;
		const pc = new RTCPeerConnection({ iceServers });
		state.pc = pc;
		pc.ontrack = (ev) => {
			if (ev.streams[0]) {
				console.info(`[webrtc] receiver got media track (stream ${streamId})`);
				video.srcObject = ev.streams[0];
				state.hasTrack = true;
				hideHint();
				// muted (set by draw) is what lets the browser autoplay it.
				void video.play().catch(() => {});
			}
		};
		pc.onicecandidate = (e) => {
			// Only the primary's candidates reach the sender (server relay).
			if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "ice", candidate: e.candidate.toJSON() }));
			}
		};
		pc.onconnectionstatechange = () => {
			if (
				pc.connectionState === "failed" ||
				pc.connectionState === "closed"
			) {
				if (!state.shadow) {
					// Active peer dropped; the sender re-offers on room-state.
					video.srcObject = null;
					state.hasTrack = false;
					showHint();
				}
			}
		};
		return pc;
	};

	/** Drop the live peer (demote to shadow); the video keeps its last frame. */
	const dropPeer = () => {
		if (state.pc) {
			state.pc.close();
			state.pc = null;
		}
		pendingCandidates = [];
		chain = Promise.resolve();
	};

	/** Apply a room-state layout: `active` = is this the live receiver. */
	const applyLayout = (active: boolean, hasSender: boolean) => {
		if (active) {
			state.shadow = false;
			ensurePeer();
			hideNote();
			if (!hasSender) showHint(); // waiting for the sender to (re)offer
		} else {
			// Shadow: freeze the last frame, show the note, drop the peer.
			state.shadow = true;
			dropPeer();
			hideHint();
			showNote();
		}
	};

	const ws = new WebSocket(signalingUrl(streamId, priority));
	state.ws = ws;
	console.info(
		`[webrtc] receiver ${priority ? "(priority)" : "(shadow)"} connecting (stream ${streamId})`,
	);
	ws.onerror = () =>
		console.warn(`[webrtc] receiver signaling error (stream ${streamId})`);
	ws.onopen = () => {
		// Joining is implicit in the WS upgrade (role in the query). Ask for the
		// layout in the open channel: the on-join room-state snapshot can race
		// this listener's setup, while a `sync` reply always arrives after the
		// socket is usable (and carries the room's ICE servers).
		ws.send(JSON.stringify({ type: "sync" }));
	};
	ws.onmessage = async (ev) => {
		// SDP frames are large; a WebSocket client may hand us a `Blob` for
		// them, so normalise to text before parsing.
		const raw = ev.data as string | Blob;
		const text = raw instanceof Blob ? await raw.text() : String(raw);
		let msg: {
			type?: string;
			sdp?: RTCSessionDescriptionInit;
			candidate?: RTCIceCandidateInit;
			state?: {
				sender?: boolean;
				receiver?: boolean;
				active?: boolean;
				iceServers?: RTCIceServer[];
			};
		};
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		switch (msg.type) {
			case "room-state":
				// Adopt the room's ICE servers (STUN + the server's minted TURN,
				// when configured). A changed set that a live peer was already
				// negotiating with forces a fresh peer — the sender re-offers
				// once this receiver drops and re-arms.
				const servers = msg.state?.iceServers;
				if (
					servers &&
					JSON.stringify(servers) !== JSON.stringify(iceServers)
				) {
					iceServers = servers;
					if (state.pc) dropPeer();
				}
				// The layout is authoritative: `active` says whether THIS
				// receiver carries the live media now.
				applyLayout(!!msg.state?.active, !!msg.state?.sender);
				break;
			case "offer": {
				// Only the primary ever receives offers; a shadow ignores any.
				const sdp = msg.sdp;
				if (sdp && !state.shadow)
					enqueue(async () => {
						const pc = ensurePeer();
						console.info(`[webrtc] receiver got offer (stream ${streamId})`);
						await pc.setRemoteDescription(sdp);
						const answer = await pc.createAnswer();
						await pc.setLocalDescription(answer);
						if (state.ws?.readyState === WebSocket.OPEN)
							state.ws.send(JSON.stringify({ type: "answer", sdp: answer }));
						await flushCandidates();
					});
				break;
			}
			case "ice": {
				const candidate = msg.candidate;
				if (candidate)
					enqueue(async () => {
						const pc = state.pc;
						let applied = false;
						if (pc) {
							try {
								await pc.addIceCandidate(candidate);
								applied = true;
							} catch {
								/* stale — requeue */
							}
						}
						// A candidate that beat the offer (no peer yet, or a
						// stale one) is played back after the offer is applied.
						if (!applied) pendingCandidates.push(candidate);
					});
				break;
			}
			case "peer-left":
				// The sender left. Active: clear the feed and wait for it to
				// return. A shadow keeps its note (it is not carrying media).
				if (!state.shadow) {
					video.srcObject = null;
					state.hasTrack = false;
					showHint();
				}
				break;
		}
	};
	ws.onclose = () => {
		if (ws === state.ws) {
			// The signaling dropped (server restarted / element removed).
			// Clear the feed; a fresh receiver attaches when the DOM
			// re-creates the element (onremove -> detachReceiver).
			dropPeer();
			video.srcObject = null;
			state.hasTrack = false;
			hideNote();
			showHint();
		}
	};

	return state;
}

/** Tear down a receiver: stop the peer + socket and detach the video source. */
function detachReceiver(streamId: string): void {
	const state = receivers.get(streamId);
	if (!state) return;
	state.pc?.close();
	state.ws.close();
	state.video.srcObject = null;
	receivers.delete(streamId);
}

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	const props = element.props;
	const streamId = typeof props.streamId === "string" ? props.streamId : "";
	// Connect in both the editor (live preview) and the runtime page. The OBS
	// runtime page — identified by its `activeTriggers` context, which only the
	// runtime builds — is `priority` and claims the live-media receiver slot;
	// the editor (and any other concurrent receiver) runs as a shadow that
	// keeps its last frame plus a note that the overlay has the feed.
	const priority = ctx.activeTriggers !== undefined;
	const live = streamId.length > 0;
	return (
		<div
			class="overlay-webrtc"
			style={{
				width: "100%",
				height: "100%",
				position: "relative",
				overflow: "hidden",
				background: "#000",
			}}
			oncreate={(vnode) => {
				const container = vnode.dom as HTMLElement;
				const video = container.querySelector(
					"video",
				) as HTMLVideoElement | null;
				if (!video) return;
				video.muted = true;
				video.playsInline = true;
				video.autoplay = true;
				const hint = container.querySelector(
					".overlay-webrtc-hint",
				) as HTMLSpanElement | null;
				const note = container.querySelector(
					".overlay-webrtc-note",
				) as HTMLSpanElement | null;
				if (live && !receivers.has(streamId)) {
					receivers.set(
						streamId,
						attachReceiver(streamId, video, hint, note, priority),
					);
				}
			}}
			onremove={() => {
				detachReceiver(streamId);
			}}
		>
			{m("video.overlay-webrtc-video", {
				style: {
					width: "100%",
					height: "100%",
					objectFit: "contain",
					background: "#000",
				},
			})}
			{m(
				"span.overlay-webrtc-hint",
				{
					style: {
						position: "absolute",
						inset: "0",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						color: "rgba(255,255,255,0.6)",
						fontSize: "13px",
						pointerEvents: "none",
						textAlign: "center",
						padding: "8px",
					},
				},
				t("overlay.webrtc_hint"),
			)}
			{m(
				"span.overlay-webrtc-note",
				{
					style: {
						position: "absolute",
						inset: "0",
						display: "none",
						alignItems: "center",
						justifyContent: "center",
						textAlign: "center",
						padding: "8px",
						pointerEvents: "none",
						color: "rgba(255,255,255,0.85)",
						fontSize: "13px",
						background: "rgba(0,0,0,0.45)",
					},
				},
				t("overlay.webrtc_shadow"),
			)}
		</div>
	);
}

function editForm({ element: e, mutate, variables, variableUrl }: ElementProps): Vnode {
	const streamId = typeof e.props.streamId === "string" ? e.props.streamId : "";
	const senderUrl = `${location.origin}/webrtc/send?streamId=${encodeURIComponent(streamId)}`;
	// The sender URL + QR are fixed per instance (the stream id is generated on
	// create), so they render read-only as raw rows. The optional TURN server
	// settings are editable `bindableForm` fields.
	const urlField = (
		<label class="field">
			<span class="field-label">{t("overlay.webrtc_sender_url")}</span>
			<input
				type="text"
				readOnly
				value={senderUrl}
				style={{ width: "100%" }}
				onclick={(ev: Event) => {
					const el = ev.target as HTMLInputElement;
					el.select();
					void el.focus();
				}}
			/>
			<button
				type="button"
				class="btn btn-secondary"
				style={{ marginTop: "6px", width: "100%" }}
				onclick={() => {
					void navigator.clipboard.writeText(senderUrl).catch(() => {});
				}}
			>
				{t("overlay.webrtc_copy")}
			</button>
		</label>
	);
	const urlHint = (
		<p
			style={{
				color: "var(--text-dim, #9aa3b2)",
				margin: "6px 0 0",
				fontSize: "13px",
			}}
		>
			{t("overlay.webrtc_hint_form")}
		</p>
	);
	const qrField = (
		<div class="field" style={{ marginTop: "10px" }}>
			<span class="field-label">{t("overlay.webrtc_qr")}</span>
			{m("canvas.overlay-webrtc-qr", {
				style: {
					display: "block",
					margin: "6px auto 0",
					borderRadius: "4px",
				},
				oncreate: (vnode) => {
					// Render the sender URL as a QR code so a phone can scan it
					// instead of typing the address; a failure just leaves the
					// canvas empty and the URL field above stays usable.
					QRCode.toCanvas(vnode.dom as HTMLCanvasElement, senderUrl, {
						width: 160,
						margin: 1,
						color: { dark: "#000", light: "#fff" },
					}).catch(() => {});
				},
			})}
		</div>
	);
	return bindableForm({
		element: e,
		mutate,
		variables,
		variableUrl,
		rows: [urlField, urlHint, qrField],
	});
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.streamId !== "string")
		problems.push("streamId is not a string");
	return problems;
}

export const webrtcElement: OverlayElementDef & OverlayElementSchema = {
	type: "webrtc",
	category: "media",

	labelKey: "overlay.add_webrtc",
	icon: () => <Icon name="video" class="role-icon" />,
	order: 81,
	defaultProps: { ...DEFAULT_WEBRTC_PROPS },
	createProps: () => ({ streamId: uuid() }),
	propKeys: ["streamId"],
	defaultSize: { width: 640, height: 360 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(_props, read) {
		// Preserve the stored per-instance id; an empty/malformed one is
		// coerced to "" (the element then renders its placeholder).
		return { streamId: read.str("streamId", "", 128) };
	},
};

export default webrtcElement;
