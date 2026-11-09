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

type Source = "user" | "environment" | "screen";

const SOURCE_NAMES: Record<Source, string> = {
	user: "Front camera",
	environment: "Back camera",
	screen: "Screen",
};

/** True when the browser can capture the screen via `getDisplayMedia`. Mobile
 * browsers (Chrome / Firefox / Samsung Internet on Android) don't implement it
 * at all, so the "Share screen" button is hidden for them. */
const supportsScreenShare =
	typeof navigator !== "undefined" &&
	!!navigator.mediaDevices &&
	"getDisplayMedia" in navigator.mediaDevices;

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
}

const ui: UiState = {
	status: validStreamId
		? { text: "Idle.", kind: "idle" }
		: { text: "Missing or invalid stream id.", kind: "error" },
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

async function start(source: Source): Promise<void> {
	stopAll();
	if (!navigator.mediaDevices) {
		setStatus(
			"Camera and screen capture need a secure context (HTTPS or localhost).",
			"error",
		);
		return;
	}
	setStatus(`Requesting ${SOURCE_NAMES[source].toLowerCase()}…`, "waiting");
	let stream: MediaStream;
	try {
		stream =
			source === "screen"
				? await navigator.mediaDevices.getDisplayMedia({
						video: true,
						audio: true,
					})
				: await navigator.mediaDevices.getUserMedia({
						// facingMode picks the physical camera ("front" is the
						// selfie one, "back" the rear one) on phones; desktops
						// simply use their only camera.
						video: { facingMode: source },
						audio: true,
					});
	} catch (err) {
		setStatus(
			`${SOURCE_NAMES[source]} unavailable: ` +
				(err instanceof Error ? err.message : String(err)),
			"error",
		);
		return;
	}
	state.stream = stream;
	state.source = source;
	m.redraw();
	// The browser offers a Stop control for screen shares; honour it.
	stream.getVideoTracks()[0]?.addEventListener("ended", () => stopAll());

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
		if (pc.connectionState === "connected") setStatus("Live.", "live");
		if (pc.connectionState === "failed" || pc.connectionState === "closed")
			stopAll();
	};

	const ws = new WebSocket(
		(location.protocol === "https:" ? "wss://" : "ws://") +
			location.host +
			`/api/webrtc/stream/${encodeURIComponent(streamId)}/ws?role=sender`,
	);
	state.ws = ws;

	ws.onopen = () => {
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
				if (msg.state?.receiver && !state.negotiating) void sendOffer();
				break;
			case "peer-joined":
				if (msg.role === "receiver" && !state.negotiating) void sendOffer();
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
				setStatus("Receiver disconnected.", "error");
				stopAll();
				break;
		}
	};
	ws.onclose = () => {
		if (state.source) setStatus("Signaling connection lost.", "error");
	};
	ws.onerror = () => {
		setStatus("Could not reach the signaling server.", "error");
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
	return (
		<main>
			<h1>Share to IRL Control</h1>
			<p class="sub">Pick a source to start streaming to the overlay.</p>
			<div class="actions">
				{/* The two camera buttons always share one row, 50/50. */}
				<div class="camera-row">
					{m(SourceButton, { source: "user", label: "Front camera" })}
					{m(SourceButton, { source: "environment", label: "Back camera" })}
				</div>
				{supportsScreenShare
					? m(SourceButton, {
							source: "screen",
							label: "Share screen",
							secondary: true,
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
window.addEventListener("beforeunload", () => stopAll());
