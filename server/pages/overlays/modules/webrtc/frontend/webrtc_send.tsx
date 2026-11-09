/*
 * The WebRTC sender page (loaded at /webrtc/send?streamId=…). Opened on a phone
 * or a second browser to publish a camera or screen feed. It dials the control
 * server's signaling WebSocket and drives the WebRTC offer as the sender.
 *
 * Standalone utility page (not part of the app shell): a small Mithril app
 * mounted on `#app`, with hardcoded copy (no i18n) and no other runtime
 * dependencies.
 */
import m from "mithril";
import { WEBRTC_STREAM_ID_RE } from "../webrtc_protocol";
import "./styles.css";

type StatusKind = "idle" | "waiting" | "live" | "error";

/** A selectable video source: a specific camera (addressed by device id) or
 * the screen. Cameras are selected by `deviceId` because `facingMode` is
 * ignored by Firefox and Safari and so cannot be relied on across browsers. */
type CameraSource = { kind: "camera"; deviceId: string; label: string };
type ScreenSource = { kind: "screen" };
type Source = CameraSource | ScreenSource;

/** True when the browser can capture the screen via `getDisplayMedia`. Mobile
 * browsers (Chrome / Firefox / Samsung Internet on Android) don't implement it
 * at all, so the "Share screen" button is hidden for them. */
const supportsScreenShare =
	typeof navigator !== "undefined" &&
	!!navigator.mediaDevices &&
	"getDisplayMedia" in navigator.mediaDevices;

/** True when the browser can list available input devices. Every supported
 * browser (Chrome, Firefox, Brave, Safari) implements it. */
const supportsCameraEnum =
	typeof navigator !== "undefined" &&
	!!navigator.mediaDevices &&
	"enumerateDevices" in navigator.mediaDevices;

/** True when the peer has reached a usable connection, on any browser.
 * `connectionState` is missing in older Firefox / some WebViews, so fall back
 * to `iceConnectionState` (which is present everywhere). */
function isConnected(pc: RTCPeerConnection): boolean {
	if (pc.connectionState === "connected") return true;
	const ice = pc.iceConnectionState;
	return ice === "connected" || ice === "completed";
}

/** True only on a hard failure (not the transient `disconnected`). Same
 * `connectionState`-absent fallback as `isConnected`. */
function isFailed(pc: RTCPeerConnection): boolean {
	return (
		pc.connectionState === "failed" || pc.iceConnectionState === "failed"
	);
}

/**
 * The ICE servers this peer uses. Defaults to STUN only; the server publishes
 * the stream's servers (STUN + the minted TURN, if configured) on every
 * `room-state` snapshot, and this is replaced with them so both ends negotiate
 * with identical servers — essential for a phone behind a restrictive NAT.
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
	{ urls: "stun:stun.l.google.com:19302" },
];

interface SenderState {
	pc: RTCPeerConnection | null;
	ws: WebSocket | null;
	stream: MediaStream | null;
	source: Source | null;
	/** true once an offer has been sent; guards against double-negotiating. */
	negotiating: boolean;
	/**
	 * Last `primary` token seen in a room-state with a receiver present.
	 * `null` when there is no receiver. A change (with a receiver present)
	 * means a NEW receiver took the live-media slot, so the sender must re-offer
	 * to it; the old peer (bound to the demoted receiver) is closed first.
	 */
	primary: number | null;
	/**
	 * True once a SECOND sender took this link (`hijacked`). When set the
	 * socket-close handler must NOT reconnect, because reconnecting would
	 * simply re-trigger the hijack and fight the (legitimate) new sender.
	 */
	hijacked: boolean;
	/** ICE candidates that arrived before the remote (answer) description was
	 * applied. Flushed once `setRemoteDescription` resolves. */
	pendingCandidates: RTCIceCandidateInit[];
	/**
	 * The ICE servers the current peer must use (STUN always, plus the element's
	 * TURN if the receiver published it). A peer already built with a different
	 * set is torn down and re-offered when this changes.
	 */
	iceServers: RTCIceServer[];
}

interface ServerMessage {
	type?: string;
	role?: string;
	sdp?: RTCSessionDescriptionInit;
	candidate?: RTCIceCandidateInit;
	/** room-state snapshot: which peers are present in the room */
	state?: {
		sender?: boolean;
		receiver?: boolean;
		/** primary-token: changes when the live-media receiver changes. */
		primary?: number;
		/** ICE servers (STUN + the server's minted TURN) for this room. */
		iceServers?: RTCIceServer[];
	};
}

const params = new URLSearchParams(location.search);
const streamId = params.get("streamId") ?? "";
const validStreamId = WEBRTC_STREAM_ID_RE.test(streamId);

/** The re-rendered UI slice; the imperative WebRTC state stays outside it. */
interface UiState {
	status: { text: string; kind: StatusKind };
	cameras: CameraSource[];
}

const ui: UiState = {
	status: validStreamId
		? { text: "Idle.", kind: "idle" }
		: { text: "Missing or invalid stream id.", kind: "error" },
	cameras: [],
};

const state: SenderState = {
	pc: null,
	ws: null,
	stream: null,
	source: null,
	negotiating: false,
	primary: null,
	hijacked: false,
	pendingCandidates: [],
	iceServers: DEFAULT_ICE_SERVERS,
};

function setStatus(text: string, kind: StatusKind = "idle"): void {
	ui.status = { text, kind };
	m.redraw();
}

/** Stop every track, close the peer + signaling socket, and reset the preview. */
function stopAll(): void {
	state.stream?.getTracks().forEach((t) => {
		t.stop();
	});
	state.stream = null;
	state.source = null;
	state.negotiating = false;
	state.primary = null;
	state.hijacked = false;
	state.pendingCandidates = [];
	state.iceServers = DEFAULT_ICE_SERVERS;
	state.pc?.close();
	state.pc = null;
	if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close();
	state.ws = null;
	m.redraw();
}

function sendOffer(): Promise<void> {
	const pc = state.pc;
	const ws = state.ws;
	if (!pc || !ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
	state.negotiating = true;
	setStatus("Connecting…", "waiting");
	return pc
		.createOffer()
		.then((offer) => pc.setLocalDescription(offer))
		.then(() => {
			// Read the authoritative local description after `setLocalDescription`
			// resolves: `setLocalDescription` returns `Promise<void>`, so relying
			// on the chain to forward the offer would hand the next step
			// `undefined` (and a frame with no `sdp`).
			const desc = pc.localDescription;
			if (!desc) return;
			ws.send(JSON.stringify({ type: "offer", sdp: desc }));
		})
		.catch((err) => {
			console.error("[webrtc] sender offer failed", err);
			state.negotiating = false;
		});
}

/**
 * Enumerate the available cameras and expose a button for each. Chrome (and
 * Brave) only populate `deviceId`/`label` *after* camera permission is granted,
 * so we capture a throwaway stream first — to satisfy the permission prompt —
 * then release it and re-enumerate. Firefox and Safari list cameras with their
 * labels without this priming, so it is a harmless no-op there.
 */
async function enumerateCameras(): Promise<void> {
	const md = navigator.mediaDevices;
	if (!md || !("enumerateDevices" in md)) return;

	const toCameras = (devices: MediaDeviceInfo[]): CameraSource[] =>
		devices
			.filter((d) => d.kind === "videoinput")
			.map((d, i) => ({
				kind: "camera" as const,
				deviceId: d.deviceId,
				// On desktop the labels read like "Face ID Camera" (Safari) or
				// "webcam"; on phones they're often empty — fall back to "N".
				label: d.label || `Camera ${i + 1}`,
			}));

	let cameras = toCameras(await md.enumerateDevices());
	// If the list is empty, or present but anonymous (Chrome pre-permission),
	// prime the permission prompt with a brief stream, then re-read the list.
	if (cameras.length === 0 || cameras.every((c) => !c.deviceId)) {
		try {
			const probe = await md.getUserMedia({ video: true });
			probe.getTracks().forEach((t) => t.stop());
			cameras = toCameras(await md.enumerateDevices());
		} catch {
			// Permission denied (or no camera at all): leave the list as-is.
		}
	}
	ui.cameras = cameras;
	m.redraw();
}

async function start(source: Source): Promise<void> {
	stopAll();
	if (!navigator.mediaDevices) {
		setStatus(
			"Camera and screen capture need a secure context (HTTPS or localhost).",
			"error",
		);
		return;
	}
	const sourceName =
		source.kind === "screen" ? "screen share" : `the ${source.label} camera`;
	setStatus(`Requesting ${sourceName}…`, "waiting");
	let stream: MediaStream;
	try {
		// Cameras are selected by `deviceId` (honoured by Chrome, Firefox,
		// Brave and Safari alike), screens via `getDisplayMedia`.
		stream =
			source.kind === "screen"
				? await navigator.mediaDevices.getDisplayMedia({
						video: true,
					})
				: await navigator.mediaDevices.getUserMedia({
						video: { deviceId: { exact: source.deviceId } },
					});
	} catch (err) {
		// A device can vanish between enumeration and selection (unplugged,
		// hot-replugged); fall back to the default camera so the user is never
		// stuck behind a single dead device.
		if (source.kind === "camera") {
			try {
				stream = await navigator.mediaDevices.getUserMedia({ video: true });
			} catch {
				setStatus(
					`Camera unavailable: ` +
						(err instanceof Error ? err.message : String(err)),
					"error",
				);
				return;
			}
		} else {
			setStatus(
				`Screen share unavailable: ` +
					(err instanceof Error ? err.message : String(err)),
				"error",
			);
			return;
		}
	}
	state.stream = stream;
	state.source = source;
	// The browser offers a Stop control for screen shares; honour it.
	stream.getVideoTracks()[0]?.addEventListener("ended", () => stopAll());
	setStatus("Waiting for the overlay to receive…", "waiting");
	// The peer connection is created lazily (in `offerFresh`) once a receiver
	// is present; the media itself stays up across signaling/peer drops so a
	// reloaded receiver can be re-offered to without re-asking for the
	// camera/screen.
	connect();
	m.redraw();
}

/**
 * (Re)build the peer connection from the live stream and wire it to the
 * current signaling socket. Reuses the existing connection when present;
 * returns null only when there is no stream to send.
 */
function preparePeer(): RTCPeerConnection | null {
	const stream = state.stream;
	if (!stream) return null;
	if (state.pc) return state.pc;
	// Use the servers the server published in `room-state` (STUN + the minted
	// TURN, when configured), else the STUN-only default.
	const pc = new RTCPeerConnection({ iceServers: state.iceServers });
	state.pc = pc;
	state.pendingCandidates = [];
	for (const track of stream.getTracks()) pc.addTrack(track, stream);
	pc.onicecandidate = (e) => {
		if (e.candidate && state.ws?.readyState === WebSocket.OPEN) {
			state.ws.send(
				JSON.stringify({ type: "ice", candidate: e.candidate.toJSON() }),
			);
		}
	};
	const onStateChange = () => {
		if (isConnected(pc)) {
			setStatus("Live.", "live");
		} else if (isFailed(pc)) {
			// A hard ICE fail usually clears with a fresh renegotiation; the
			// receiver is (presumably) still present, so re-offer.
			state.negotiating = false;
			pc.close();
			state.pc = null;
			offerFresh();
		}
	};
	pc.onconnectionstatechange = onStateChange;
	// Older Firefox (<113) has no `connectionState`/`connectionstatechange`;
	// `iceConnectionState` is the portable fallback and is safe to listen to
	// unconditionally (it's a no-op on browsers that have both).
	pc.oniceconnectionstatechange = onStateChange;
	return pc;
}

/**
 * Build the peer (if needed) and send a fresh offer, at most once. With
 * `force` (a NEW primary receiver took the live-media slot) the existing peer
 * — bound to the receiver that was demoted to a shadow — is closed first so the
 * fresh offer negotiates clean ICE with the new receiver.
 */
function offerFresh(force = false): void {
	if (force) {
		state.negotiating = false;
		state.pc?.close();
		state.pc = null;
	}
	if (state.negotiating) return;
	if (preparePeer()) void sendOffer();
}

/**
 * Open (or reopen) the signaling socket and wire its handlers. The media
 * stream is kept for the whole session; only the socket and the peer
 * connection are (re)created here, so a receiver that drops — e.g. its overlay
 * tab reloads — can be re-offered to without re-asking for the camera/screen.
 */
function connect(): void {
	const ws = new WebSocket(
		(location.protocol === "https:" ? "wss://" : "ws://") +
			location.host +
			`/api/webrtc/stream/${encodeURIComponent(streamId)}/ws?role=sender`,
	);
	state.ws = ws;

	ws.onopen = () => {
		if (state.source && !state.negotiating)
			setStatus("Waiting for the overlay to receive…", "waiting");
		// Ask for the room layout right after the socket is usable: the
		// server's on-join snapshot can race this listener's setup, while a
		// `sync` reply always arrives in the open channel.
		ws.send(JSON.stringify({ type: "sync" }));
	};
	ws.onmessage = async (event: MessageEvent) => {
		let msg: ServerMessage;
		try {
			msg = JSON.parse(String(event.data));
		} catch {
			return;
		}
		// offer/answer/ice are relayed between the two peers; room-state gives
		// a trustworthy snapshot of who is present (authoritative over
		// peer-joined, which can be missed during connection setup).
		switch (msg.type) {
			case "room-state": {
				const st = msg.state;
				if (
					st?.iceServers &&
					JSON.stringify(st.iceServers) !== JSON.stringify(state.iceServers)
				) {
					// The room's ICE servers changed (TURN credentials were
					// minted/rotated). A live peer negotiating with the old set
					// must be renegotiated to pick up the new ones.
					state.iceServers = st.iceServers;
					if (state.pc) {
						state.negotiating = false;
						state.pc.close();
						state.pc = null;
					}
					state.primary = null;
					offerFresh(true);
					break;
				}
				if (st?.receiver) {
					const token = st.primary ?? 0;
					if (state.primary !== null && state.primary !== token) {
						// A DIFFERENT receiver became the primary (a priority
						// one — the OBS page — took the slot, or the primary
						// left and another promoted). Re-offer to the new
						// primary; the old peer (bound to the now-shadow
						// receiver) is dropped.
						offerFresh(true);
					} else {
						offerFresh();
					}
					state.primary = token;
				} else {
					// No receiver left: forget the primary so a fresh join
					// negotiates clean.
					state.primary = null;
				}
				break;
			}
			case "peer-joined":
				if (msg.role === "receiver") offerFresh();
				break;
			case "answer":
				if (state.pc && msg.sdp) {
					await state.pc.setRemoteDescription(msg.sdp);
					// Flush candidates that arrived while we were waiting for the
					// answer — adding them earlier (no remote description) would
					// have thrown and dropped them.
					const pending = state.pendingCandidates;
					state.pendingCandidates = [];
					for (const candidate of pending) {
						try {
							await state.pc.addIceCandidate(candidate);
						} catch {
							/* candidate can reference a stale generation; ignore */
						}
					}
				}
				break;
			case "ice":
				if (state.pc && msg.candidate) {
					if (state.pc.remoteDescription) {
						try {
							await state.pc.addIceCandidate(msg.candidate);
						} catch {
							/* ignore */
						}
					} else {
						// Remote description not set yet — buffer until the
						// answer arrives.
						state.pendingCandidates.push(msg.candidate);
					}
				}
				break;
			case "peer-left":
				// The receiver went away (e.g. its overlay tab reloaded). Keep
				// the media up and tear down the peer so the rejoin gets a
				// clean, fresh offer instead of a stale handshake.
				if (state.ws === ws) {
					state.negotiating = false;
					state.pc?.close();
					state.pc = null;
					if (state.source)
						setStatus("Receiver disconnected – reconnecting…", "waiting");
				}
				break;
			case "hijacked":
				// A SECOND sender opened the same link and took the slot. Tear
				// down everything and tell the user. Crucially, flag
				// `state.hijacked` so the socket-close that follows does NOT
				// auto-reconnect — reconnecting would re-trigger the hijack and
				// ping-pong with the (legitimate) new sender.
				if (state.ws !== ws) break;
				state.hijacked = true;
				state.ws = null;
				state.negotiating = false;
				state.pc?.close();
				state.pc = null;
				stopAll();
				setStatus(
					"Your link was taken over by a new sender. This page has stopped.",
					"error",
				);
				break;
		}
	};
	// A dropped signaling link (network blip, server restart) keeps the media
	// running and re-opens the socket so it re-joins the room and picks up a
	// (re)loaded receiver. Skipped after a hijack (we were displaced, not a
	// transient drop — reconnecting would just re-trigger the hijack).
	ws.onclose = () => {
		if (state.ws !== ws || state.hijacked) return; // taken over / hijacked
		state.ws = null;
		state.negotiating = false;
		state.pc?.close();
		state.pc = null;
		if (state.stream && state.source) {
			setStatus("Connection lost – reconnecting…", "waiting");
			setTimeout(() => {
				if (state.stream && state.source && !state.ws) connect();
			}, 1000);
		}
	};
	ws.onerror = () => {
		// nothing to send; the onclose handler drives the reconnect.
	};
}

/**
 * Point the (Mithril-managed) preview at the current stream, playing it on
 * attach. m.redraw never writes `srcObject`, so the hook syncs it from the
 * imperative state (null clears the preview on stop).
 */
function syncPreview(preview: HTMLVideoElement): void {
	const stream = state.stream;
	if (preview.srcObject === stream) return;
	preview.srcObject = stream;
	if (stream) void preview.play().catch(() => {});
}

/** Inline source glyphs (the page is standalone — no shared icon import).
 * 24×24 outline shapes stroked with the button's text colour (see styles.css). */
const CAMERA_ICON = (
	<svg class="src-icon" viewBox="0 0 24 24" aria-hidden="true">
		<rect x="3" y="6" width="13" height="12" rx="2" />
		<path d="m16 10.5 5-3v9l-5-3" />
	</svg>
);
const SCREEN_ICON = (
	<svg class="src-icon" viewBox="0 0 24 24" aria-hidden="true">
		<rect x="2" y="4" width="20" height="13" rx="2" />
		<path d="M8 21h8M12 17v4" />
	</svg>
);

interface SourceButtonAttrs {
	source: Source;
	label: string;
	icon: "camera" | "screen";
	secondary?: boolean;
}

const SourceButton: m.Component<SourceButtonAttrs> = {
	view(vnode) {
		const { source, label, icon, secondary = false } = vnode.attrs;
		return (
			<button
				type="button"
				class={secondary ? "secondary" : undefined}
				disabled={!validStreamId}
				onclick={() => void start(source)}
			>
				{icon === "camera" ? CAMERA_ICON : SCREEN_ICON}
				{label}
			</button>
		);
	},
};

const StatusLine: m.Component = {
	view() {
		const { text, kind } = ui.status;
		return (
			<p
				class={
					"status" +
					(kind === "live" ? " is-live" : kind === "error" ? " is-error" : "")
				}
			>
				{text}
			</p>
		);
	},
};

const Preview: m.Component = {
	view() {
		return (
			<video
				class="preview"
				autoplay
				muted
				playsInline
				oncreate={(vnode) => syncPreview(vnode.dom as HTMLVideoElement)}
				onupdate={(vnode) => syncPreview(vnode.dom as HTMLVideoElement)}
			/>
		);
	},
};

function App(): m.Vnode {
	const cameras = ui.cameras;
	return (
		<main>
			<h1>Share to IRL Control</h1>
			<p class="sub">Pick a source to start streaming to the overlay.</p>
			<div class="actions">
				{supportsCameraEnum
					? cameras.map((camera) =>
							m(SourceButton, {
								key: camera.deviceId,
								source: camera,
								label: camera.label,
								icon: "camera",
							}),
						)
					: null}
				{supportsScreenShare
					? m(SourceButton, {
							source: { kind: "screen" as const },
							label: "Share screen",
							icon: "screen",
						})
					: null}
				<button
					type="button"
					class="secondary"
					disabled={!state.source}
					onclick={() => {
						stopAll();
						setStatus("Stopped.", "idle");
					}}
				>
					Stop
				</button>
			</div>
			{m(StatusLine)}
			{m(Preview)}
		</main>
	);
}

m.mount(document.getElementById("app") as HTMLElement, { view: App });
// Populate the per-camera buttons once; the list is stable for a given
// device set, so a one-shot enumeration is enough for this standalone page.
if (supportsCameraEnum) {
	void enumerateCameras();
}
window.addEventListener("beforeunload", () => stopAll());
