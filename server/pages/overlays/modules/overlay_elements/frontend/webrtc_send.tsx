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

interface SenderState {
	pc: RTCPeerConnection | null;
	ws: WebSocket | null;
	stream: MediaStream | null;
	source: Source | null;
	/** true once an offer has been sent; guards against double-negotiating. */
	negotiating: boolean;
}

interface ServerMessage {
	type?: string;
	role?: string;
	sdp?: RTCSessionDescriptionInit;
	candidate?: RTCIceCandidateInit;
	/** room-state snapshot: which peers are present in the room */
	state?: { sender?: boolean; receiver?: boolean };
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
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
	});
	state.pc = pc;
	for (const track of stream.getTracks()) pc.addTrack(track, stream);
	pc.onicecandidate = (e) => {
		if (e.candidate && state.ws?.readyState === WebSocket.OPEN) {
			state.ws.send(
				JSON.stringify({ type: "ice", candidate: e.candidate.toJSON() }),
			);
		}
	};
	pc.onconnectionstatechange = () => {
		if (pc.connectionState === "connected") {
			setStatus("Live.", "live");
		} else if (pc.connectionState === "failed") {
			// A hard ICE fail usually clears with a fresh renegotiation; the
			// receiver is (presumably) still present, so re-offer.
			state.negotiating = false;
			pc.close();
			state.pc = null;
			offerFresh();
		}
	};
	return pc;
}

/** Build the peer (if needed) and send a fresh offer, at most once. */
function offerFresh(): void {
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
			case "room-state":
				// A receiver is present (fresh, or it just reloaded): offer.
				if (msg.state?.receiver) offerFresh();
				break;
			case "peer-joined":
				if (msg.role === "receiver") offerFresh();
				break;
			case "answer":
				if (state.pc && msg.sdp) {
					await state.pc.setRemoteDescription(msg.sdp);
				}
				break;
			case "ice":
				if (state.pc && msg.candidate) {
					try {
						await state.pc.addIceCandidate(msg.candidate);
					} catch {
						/* candidates can race the remote description; ignore */
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
		}
	};
	// A dropped signaling link (network blip, server restart) keeps the media
	// running and re-opens the socket so it re-joins the room and picks up a
	// (re)loaded receiver.
	ws.onclose = () => {
		if (state.ws !== ws) return; // a newer socket already took over
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

interface SourceButtonAttrs {
	source: Source;
	label: string;
	secondary?: boolean;
}

const SourceButton: m.Component<SourceButtonAttrs> = {
	view(vnode) {
		const { source, label, secondary = false } = vnode.attrs;
		return (
			<button
				type="button"
				class={secondary ? "secondary" : undefined}
				disabled={!validStreamId}
				onclick={() => void start(source)}
			>
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
							}),
						)
					: null}
				{supportsScreenShare
					? m(SourceButton, {
							source: { kind: "screen" as const },
							label: "Share screen",
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
