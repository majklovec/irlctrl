/*
 * The WebRTC sender page (loaded at /webrtc/send?streamId=…). Opened on a phone
 * or a second browser to publish a camera or screen feed. It dials the control
 * server's signaling WebSocket and drives the WebRTC offer as the sender.
 *
 * Self-contained on purpose: it is a standalone utility page (not part of the
 * app shell), so it uses plain DOM + hardcoded copy rather than the bundled
 * Mithril/i18n stack, exactly like the OBS overlay runtime page.
 */
import { WEBRTC_STREAM_ID_RE } from "../webrtc_protocol";

type StatusKind = "idle" | "waiting" | "live" | "error";

type Source = "front" | "back" | "screen";

const SOURCE_NAMES: Record<Source, string> = {
	front: "Front camera",
	back: "Back camera",
	screen: "Screen",
};

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

const frontBtn = document.getElementById(
	"share-camera-front",
) as HTMLButtonElement | null;
const backBtn = document.getElementById(
	"share-camera-back",
) as HTMLButtonElement | null;
const screenBtn = document.getElementById(
	"share-screen",
) as HTMLButtonElement | null;
const stopBtn = document.getElementById("stop") as HTMLButtonElement | null;
const statusEl = document.getElementById(
	"status",
) as HTMLParagraphElement | null;
const preview = document.getElementById("preview") as HTMLVideoElement | null;

const state: SenderState = {
	pc: null,
	ws: null,
	stream: null,
	source: null,
	negotiating: false,
};

function setStatus(text: string, kind: StatusKind = "idle"): void {
	if (!statusEl) return;
	statusEl.textContent = text;
	statusEl.className =
		"status" +
		(kind === "live" ? " is-live" : kind === "error" ? " is-error" : "");
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
	if (preview) preview.srcObject = null;
	if (stopBtn) stopBtn.disabled = true;
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
	if (preview) {
		preview.srcObject = stream;
		void preview.play().catch(() => {});
	}
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
		if (stopBtn) stopBtn.disabled = false;
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

if (
	!WEBRTC_STREAM_ID_RE.test(streamId) ||
	!frontBtn ||
	!backBtn ||
	!screenBtn ||
	!stopBtn ||
	!statusEl ||
	!preview
) {
	setStatus("Missing or invalid stream id.", "error");
	if (frontBtn) frontBtn.disabled = true;
	if (backBtn) backBtn.disabled = true;
	if (screenBtn) screenBtn.disabled = true;
} else {
	frontBtn.addEventListener("click", () => void start("front"));
	backBtn.addEventListener("click", () => void start("back"));
	screenBtn.addEventListener("click", () => void start("screen"));
}
stopBtn?.addEventListener("click", () => {
	stopAll();
	setStatus("Stopped.", "idle");
});
window.addEventListener("beforeunload", () => stopAll());
