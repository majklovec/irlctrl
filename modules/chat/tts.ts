/**
 * Czech text-to-speech for the chat widget — Web Speech API
 * (`speechSynthesis`) wrapper, browser-only. The chat module reads chat
 * messages out loud through a preferred Czech eSpeak voice.
 *
 * Known pitfalls handled here (measured on the user's Linux + Chrome setup):
 * - `getVoices()` returns a fresh object graph per call (13 382 voices) — a
 *   per-message call would cause micro-stutters and a memory leak. We fetch
 *   once at init and cache the reference.
 * - `getVoices()` returns `[]` on the first call on every platform — we wait
 *   for `voiceschanged` with a timeout fallback.
 * - Chrome occasionally never fires `utterance.onend` (short utterances) — a
 *   safety timeout releases the queue.
 *
 * Module state is deliberately global (one queue, one voice) so several chat
 * widgets on one dashboard share a single voice and never overlap.
 */

/** Preferred Czech voice names, best first (substring match against
 * `SpeechSynthesisVoice.name`). Empty `ttsVoice` config falls back to the
 * first match, then to the first Czech voice. */
const PREFERRED = [
	"klatt3",
	"klatt4",
	"male3",
	"male7",
	"female2",
	"female5",
] as const;

/** The `voiceschanged` fallback when the event never fires. */
const VOICES_TIMEOUT_MS = 4000;
/** The queue-releasing safety net when `onend`/`onerror` never fire. */
const UTTERANCE_TIMEOUT_MS = 20_000;

const synth = (): SpeechSynthesis | null =>
	typeof window !== "undefined" && "speechSynthesis" in window
		? window.speechSynthesis
		: null;

let voices: SpeechSynthesisVoice[] = [];
let voice: SpeechSynthesisVoice | undefined;
let rate = 1;
let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;
let initializedWith = "";

/** All voices whose language is Czech (`cs`, `cs-CZ`, …). */
export function getCzechVoices(): SpeechSynthesisVoice[] {
	return voices.filter((v) => /^cs([-_].+)?$/i.test(v.lang));
}

/** Voices available right now (empty until the voice list has loaded). */
export function speechVoices(): SpeechSynthesisVoice[] {
	return voices;
}

/** Voice names available right now (empty until the list has loaded). */
export function speechVoiceNames(): string[] {
	return voices.map((v) => v.name);
}

/** The currently selected voice name ("" when not ready). */
export function voiceName(): string {
	return voice?.name ?? "";
}

/** Whether a Czech voice has been selected (speech is possible). */
export function isReady(): boolean {
	return voice !== undefined;
}

/**
 * Load (and cache) the browser's voice list. Memoized — repeated calls share
 * one in-flight load. Deliberately separate from `initTts`: listing voices
 * (config editor) must not re-pick the active voice.
 */
export function ensureVoices(): Promise<SpeechSynthesisVoice[]> {
	if (!voicesPromise) voicesPromise = waitForVoices(VOICES_TIMEOUT_MS);
	return voicesPromise;
}

/**
 * Wait until `getVoices()` is non-empty: `voiceschanged` first, a timeout as
 * fallback (the initial call returns `[]` on every platform).
 */
function waitForVoices(timeoutMs: number): Promise<SpeechSynthesisVoice[]> {
	const s = synth();
	if (!s) return Promise.resolve([]);

	const cached = s.getVoices();
	if (cached.length) return Promise.resolve(cached);

	return new Promise<SpeechSynthesisVoice[]>((resolve) => {
		let settled = false;
		const finish = (list: SpeechSynthesisVoice[]): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			s.removeEventListener("voiceschanged", onChange);
			resolve(list);
		};
		const onChange = (): void => {
			const list = s.getVoices();
			if (list.length) finish(list);
		};
		const timer = setTimeout(() => {
			finish(s.getVoices());
		}, timeoutMs);

		s.addEventListener("voiceschanged", onChange);
		// Some browsers fire `voiceschanged` synchronously-ish; re-check.
		const retry = s.getVoices();
		if (retry.length) finish(retry);
	});
}

/** Pick the voice for a preferred-name substring ("" = the PREFERRED list).
 * A configured name may name any voice (the config select lists the browser's
 * full voice list), so a specific name matches across all voices; the empty
 * default stays within Czech voices. */
function pickVoice(preferred: string): SpeechSynthesisVoice | undefined {
	const want = preferred.trim();
	if (!want) {
		const czech = getCzechVoices();
		for (const name of PREFERRED) {
			const hit = czech.find((v) => v.name.toLowerCase().includes(name));
			if (hit) return hit;
		}
		return czech[0];
	}

	const hit = voices.find(
		(v) => v.name.toLowerCase().includes(want.toLowerCase()),
	);
	return hit ?? voice; // a voice that vanished since saving keeps the speech going
}

/**
 * Select the voice. `preferred` is a `voice.name` substring ("" picks the
 * first PREFERRED Czech match, then the first Czech voice). Resolves `true`
 * when a voice was selected. Repeated calls with the same `preferred` are
 * memoized; a changed `preferred` re-picks the voice (the cached list makes
 * it cheap).
 */
export async function initTts(preferred = ""): Promise<boolean> {
	if (initializedWith === preferred && voice !== undefined) return true;

	initializedWith = preferred;
	voices = await ensureVoices();
	voice = pickVoice(preferred);
	if (voice) {
		console.log(
			`[chat-tts] Hlas (${preferred ? "dle konfigurace" : "výchozí"}): ${voice.name} [${voice.lang}]`,
		);
	} else {
		console.warn("[chat-tts] Žádný český hlas není k dispozici.");
	}
	return isReady();
}

/**
 * Apply a speech rate (0.5–1.5); out-of-range values are ignored. Takes
 * effect on the next utterance (also when the previous one is still
 * speaking).
 */
export function setRate(next: number): void {
	if (!Number.isFinite(next) || next < 0.5 || next > 1.5) return;
	rate = next;
}

/** One queued utterance: its source chat message id (for selective cancel)
 * and the text to speak. */
interface QueuedSpeech {
	id: string;
	text: string;
}

/** The queue of pending utterances and the in-flight flag. */
let queue: QueuedSpeech[] = [];
/** The chat message id of the utterance being spoken ("" = none). */
let speakingId = "";
let speaking = false;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

function startSafetyTimer(): void {
	if (safetyTimer) clearTimeout(safetyTimer);
	safetyTimer = setTimeout(() => {
		safetyTimer = null;
		// `onend` never fired — release the queue (Chrome quirk).
		speaking = false;
		speakingId = "";
		drain();
	}, UTTERANCE_TIMEOUT_MS);
}

function endUtterance(): void {
	if (safetyTimer) {
		clearTimeout(safetyTimer);
		safetyTimer = null;
	}
	speaking = false;
	speakingId = "";
	drain();
}

function drain(): void {
	const s = synth();
	if (!s || speaking || !queue.length) return;

	const next = queue.shift();
	if (next === undefined) return;

	const u = new SpeechSynthesisUtterance(next.text);
	if (voice) {
		u.voice = voice;
		u.lang = voice.lang;
	}
	u.rate = rate;
	u.onend = endUtterance;
	u.onerror = endUtterance;

	speaking = true;
	speakingId = next.id;
	startSafetyTimer();
	s.speak(u);
}

/** Queue one utterance; the queue drains one-by-one (never overlapping). `id`
 * is the source chat message's id, kept so `banSpeech` can cancel it. */
export function enqueueSpeech(id: string, text: string): void {
	const s = synth();
	if (!s || !isReady() || !text) return;
	queue.push({ id, text });
	drain();
}

/**
 * Stop the speech for one chat message — its TTS twin of a message being
 * banned. Cancels the in-flight utterance when it is this message, and drops
 * any still-queued entries for it; other pending messages keep speaking.
 */
export function banSpeech(id: string): void {
	if (speakingId === id) {
		stopSpeech();
		return;
	}
	queue = queue.filter((item) => item.id !== id);
}

/** Empty the queue and cancel the in-flight utterance. */
export function stopSpeech(): void {
	queue = [];
	speaking = false;
	speakingId = "";
	if (safetyTimer) {
		clearTimeout(safetyTimer);
		safetyTimer = null;
	}
	synth()?.cancel();
}
