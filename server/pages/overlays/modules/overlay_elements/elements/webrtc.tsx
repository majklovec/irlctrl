/** @jsx m */

/*
 * The WebRTC element: a rectangle that shows a live remote camera/screen feed.
 * Each instance carries its own `streamId` (generated on create via
 * `createProps`, so no two elements share a stream). The edit form shows the
 * sender URL the owner shares with a phone; the page at that URL dials the
 * control server's signaling WebSocket as `sender` and publishes its media.
 *
 * The receiver connects in BOTH the editor (live preview) and the runtime page,
 * mirroring the self-contained `chat` element: the room holds a single receiver
 * slot, and a late receiver (e.g. the OBS page opening) simply replaces the
 * earlier one. The hint text shows while no sender has connected yet.
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { uuid } from "@ui/util";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

export interface WebrtcProps {
	/** Auto-generated per instance; not user-editable. Seeds the sender URL. */
	streamId: string;
}

export const DEFAULT_WEBRTC_PROPS: Required<WebrtcProps> = { streamId: "" };

interface ReceiverState {
	pc: RTCPeerConnection;
	ws: WebSocket;
	video: HTMLVideoElement;
	/** The "Waiting for a sender" hint; hidden the moment media lands. */
	hint: HTMLSpanElement | null;
	/** True once a remote track has been rendered; drives the hint. */
	hasTrack: boolean;
}

/** One live receiver per stream id (a stream's receiver re-attach is a no-op). */
const receivers = new Map<string, ReceiverState>();

/** The signaling WebSocket for a stream id (same origin, role receiver). */
function signalingUrl(streamId: string): string {
	return (
		(location.protocol === "https:" ? "wss://" : "ws://") +
		location.host +
		`/api/webrtc/stream/${encodeURIComponent(streamId)}/ws?role=receiver`
	);
}

/** Open the signaling socket + peer connection and drive the answerer. */
function attachReceiver(
	streamId: string,
	video: HTMLVideoElement,
	hint: HTMLSpanElement | null,
): ReceiverState {
	const state: ReceiverState = {
		pc: null as unknown as RTCPeerConnection,
		ws: null as unknown as WebSocket,
		video,
		hint,
		hasTrack: false,
	};
	const showHint = () => {
		state.hasTrack = false;
		if (state.hint) state.hint.style.display = "";
	};
	const ws = new WebSocket(signalingUrl(streamId));
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
	});
	state.pc = pc;
	state.ws = ws;
	console.info(`[webrtc] receiver connecting (stream ${streamId})`);
	ws.onerror = () =>
		console.warn(`[webrtc] receiver signaling error (stream ${streamId})`);

	pc.ontrack = (ev) => {
		if (ev.streams[0]) {
			console.info(`[webrtc] receiver got media track (stream ${streamId})`);
			video.srcObject = ev.streams[0];
			state.hasTrack = true;
			if (state.hint) state.hint.style.display = "none";
			// muted (set by draw) is what lets the browser autoplay it.
			void video.play().catch(() => {});
		}
	};
	pc.onicecandidate = (e) => {
		if (e.candidate && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "ice", candidate: e.candidate.toJSON() }));
		}
	};
	pc.onconnectionstatechange = () => {
		if (pc.connectionState === "failed" || pc.connectionState === "closed") {
			video.srcObject = null;
			showHint();
		}
	};

	// The room join is implicit in the upgrade (role in the URL); the receiver
	// just answers the sender's offer. Signaling frames are SERIALIZED: an ICE
	// candidate can race the offer (and `addIceCandidate` before a remote
	// description throws, wedging the peer), so frames queue in arrival order
	// and candidates that beat the offer are replayed after it is applied.
	let pendingCandidates: RTCIceCandidateInit[] = [];
	const flushCandidates = async () => {
		const queue = pendingCandidates;
		pendingCandidates = [];
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
	ws.onmessage = (ev) => {
		let msg: {
			type?: string;
			sdp?: RTCSessionDescriptionInit;
			candidate?: RTCIceCandidateInit;
		};
		try {
			msg = JSON.parse(String(ev.data));
		} catch {
			return;
		}
		switch (msg.type) {
			case "offer": {
				const sdp = msg.sdp;
				if (sdp)
					enqueue(async () => {
						console.info(`[webrtc] receiver got offer (stream ${streamId})`);
						await pc.setRemoteDescription(sdp);
						const answer = await pc.createAnswer();
						await pc.setLocalDescription(answer);
						if (ws.readyState === WebSocket.OPEN)
							ws.send(JSON.stringify({ type: "answer", sdp: answer }));
						await flushCandidates();
					});
				break;
			}
			case "ice": {
				const candidate = msg.candidate;
				if (candidate)
					enqueue(async () => {
						// A candidate that arrives before the offer's remote
						// description throws; queue it and let the offer
						// handler replay it (flushCandidates).
						try {
							await pc.addIceCandidate(candidate);
						} catch {
							pendingCandidates.push(candidate);
						}
					});
				break;
			}
			case "peer-left":
				video.srcObject = null;
				showHint();
				break;
		}
	};
	ws.onclose = () => {
		// The signaling dropped (server restarted / element removed). Clear the
		// feed; a fresh receiver attaches when the DOM re-creates the element.
		video.srcObject = null;
		showHint();
	};

	return state;
}

/** Tear down a receiver: stop the peer + socket and detach the video source. */
function detachReceiver(streamId: string): void {
	const state = receivers.get(streamId);
	if (!state) return;
	state.pc.close();
	state.ws.close();
	state.video.srcObject = null;
	receivers.delete(streamId);
}

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const streamId =
		typeof element.props.streamId === "string" ? element.props.streamId : "";
	// Connect in both the editor (live preview) and the runtime page; the room
	// holds a single receiver slot and a late receiver replaces the earlier
	// one (see header comment), so both can connect safely.
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
				if (live && !receivers.has(streamId)) {
					receivers.set(streamId, attachReceiver(streamId, video, hint));
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
		</div>
	);
}

function editForm({ element: e }: ElementProps): Vnode {
	const streamId = typeof e.props.streamId === "string" ? e.props.streamId : "";
	const senderUrl = `${location.origin}/webrtc/send?streamId=${encodeURIComponent(streamId)}`;
	return (
		<>
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
			<p
				style={{
					color: "var(--text-dim, #9aa3b2)",
					margin: "6px 0 0",
					fontSize: "13px",
				}}
			>
				{t("overlay.webrtc_hint_form")}
			</p>
		</>
	);
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
