import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import type { Window as HappyWindow } from "happy-dom";
import type { ElementContext, OverlayElement } from "../shared/ui/overlay/element";

/*
 * DOM-level test that the spin wheel ALWAYS spins for the configured
 * duration: mounts the real box (happy-dom as the DOM), stubs the disc's Web
 * Animations API `animate`, fires the runtime trigger, and asserts the
 * animation is started with exactly the configured duration and a forward
 * multi-turn rotation. Also asserts an in-flight spin is interrupted cleanly
 * (the old animation is cancelled) and a new full-duration spin starts.
 *
 * Note: this exercises the WAAPI path, which is what makes the spin reliable —
 * the previous CSS-transition approach only turned the wheel when a Mithril
 * redraw happened to fire it, so it spun "only sometimes".
 *
 * happy-dom globals are wired in beforeAll and restored in afterAll — bun test
 * shares globalThis across concurrently-run files, so a leaked DOM/fetch would
 * break the real-server tests (same pattern as
 * overlay_templates_vars_form.test.ts).
 */

type Def = typeof import(
	"../server/pages/overlays/modules/overlay_elements/elements/spin_wheel"
)["spinWheelElement"];

interface RecordedSpin {
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
	cancelled: boolean;
	/** the WAAPI `onfinish` the element attached, so the test can fire the
	 * end-of-spin (which is what reveals the winning-segment highlight). */
	onfinish?: () => void;
}

let win: HappyWindow;
let mithril: {
	mount: typeof import("mithril").mount;
	redraw: typeof import("mithril").redraw;
};
let def: Def;

const savedGlobals: [string, unknown][] = [];
const GLOBAL_KEYS: (keyof typeof globalThis)[] = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"getComputedStyle",
	"requestAnimationFrame",
	"cancelAnimationFrame",
];

// Mithril is a singleton: `redraw()` re-renders EVERY mounted root. Each test
// must therefore mount a FRESH root (unique element id — `spinTargets` is keyed
// by it) and unmount it after, so a stale root cannot consume a later test's
// pending spin. `mounted` tracks live roots for cleanup.
const mounted: HTMLElement[] = [];

afterEach(() => {
	for (const node of mounted.splice(0)) mithril.mount(node, null);
});

afterAll(() => {
	const g = globalThis as Record<string, unknown>;
	for (const [key, original] of savedGlobals) g[key] = original;
	savedGlobals.length = 0;
});

beforeAll(async () => {
	const { Window } = await import("happy-dom");
	win = new Window();
	const g = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) savedGlobals.push([key, g[key] as unknown]);
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = (el: Element) => win.getComputedStyle(el);
	g.requestAnimationFrame = win.requestAnimationFrame;
	g.cancelAnimationFrame = win.cancelAnimationFrame;

	mithril = (await import("mithril")).default as typeof mithril;
	def = (
		await import(
			"../server/pages/overlays/modules/overlay_elements/elements/spin_wheel"
		)
	).spinWheelElement;
}, 15000);

const el = (id: string, over: Record<string, unknown> = {}): OverlayElement =>
	({
		id,
		name: "wheel",
		type: "spin_wheel",
		transform: { x: 0, y: 0, width: 340, height: 340, rotation: 0, opacity: 1 },
		visible: true,
		locked: false,
		parentId: null,
		bindings: {},
		props: {
			event: "spin",
			prizes: ["A", "B", "C", "D"],
			duration: 4000,
			...over,
		},
	}) as OverlayElement;

const runtimeCtx = (id: string): ElementContext =>
	({
		assetUrls: new Map(),
		variables: new Map(),
		variableNames: new Map(),
		// the wheel is `persistent`, so it renders whenever the runtime passes
		// an activeTriggers map (present or not) — activeTriggers is not what
		// shows it.
		activeTriggers: new Map([
			[id, { startedAt: 0, expiresAt: 9e9, payload: {} }],
		]),
	}) as ElementContext;

async function until(fn: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end)
			throw new Error("timed out waiting for the spin to settle");
		await new Promise((r) => setTimeout(r, 10));
	}
}

function degOf(keyframe: Keyframe): number {
	const t = String((keyframe as Record<string, unknown>).transform ?? "");
	const m = /rotate\((-?[\d.]+)deg\)/.exec(t);
	return m ? parseFloat(m[1]) : NaN;
}

/** Mount the real box for `id`, stub the disc's `animate`, and return the
 * recorded-animation list plus a trigger helper. The disc is the node tagged
 * `[data-disc]` — the same selector the element's `resolveDisc` uses to bind
 * the animation target (Mithril 2.3.x has no `ref` hook). */
function mountAndStub(id: string) {
	const element = el(id);
	const root = win.document.createElement("div");
	win.document.body.appendChild(root);
	mithril.mount(root, { view: () => def.draw(element, runtimeCtx(id)) } as never);
	mounted.push(root);

	const disc = root.querySelector<HTMLElement>("[data-disc]");
	if (!disc) throw new Error("rotating disc node not found in the mounted box");

	const recordings: RecordedSpin[] = [];
	// The stub returns an object; the element then attaches `onfinish` to it
	// (see `startSpin`), so we capture that by having the setter funnel into the
	// recording. This lets the test fire the end-of-spin and assert the winner
	// highlight.
	const stub = (frames: Keyframe[], opts: KeyframeAnimationOptions) => {
		const rec: RecordedSpin = {
			keyframes: frames,
			options: opts,
			cancelled: false,
		};
		recordings.push(rec);
		return {
			cancel: () => {
				rec.cancelled = true;
			},
			set onfinish(handler: () => void) {
				rec.onfinish = handler;
			},
		};
	};
	(disc as { animate: unknown }).animate = stub;

	const highlight = root.querySelector<HTMLElement>("[data-highlight]");
	if (!highlight)
		throw new Error("winning-segment highlight node not found in the mounted box");
	// Stub the highlight's `animate` too: `showHighlight` (driven by the spin's
	// `onfinish`) starts a looping opacity pulse on it. Recording these calls
	// is the test-side signal that the winner was revealed.
	const pulses: KeyframeAnimationOptions[] = [];
	(highlight as { animate: unknown }).animate = (_f: Keyframe[], o: KeyframeAnimationOptions) => {
		pulses.push(o);
		return { cancel: () => {} };
	};
	return { recordings, highlight, pulses };
}

describe("spin_wheel spin (WAAPI)", () => {
	test("fires a full-duration spin from the trigger", async () => {
		const { recordings } = mountAndStub("w-1");
		def.onTrigger?.(el("w-1"), "spin", {}, runtimeCtx("w-1"));
		mithril.redraw(true);
		await until(() => recordings.length >= 1);

		expect(recordings.length).toBe(1);
		const spin = recordings[0];
		expect(spin.options.duration).toBe(4000);
		// forward multi-turn: at least 4 full turns (1440deg) from the start
		const from = degOf(spin.keyframes[0]);
		const to = degOf(spin.keyframes[spin.keyframes.length - 1]);
		expect(to - from).toBeGreaterThanOrEqual(1440);
		expect(to - from).toBeLessThan(1800);
	});

	test("an in-flight spin is interrupted: old cancelled, new full-duration spin", async () => {
		const { recordings } = mountAndStub("w-2");
		def.onTrigger?.(el("w-2"), "spin", {}, runtimeCtx("w-2"));
		mithril.redraw(true);
		await until(() => recordings.length >= 1);

		// a second trigger while the first is "in flight"
		def.onTrigger?.(el("w-2"), "spin", {}, runtimeCtx("w-2"));
		mithril.redraw(true);
		await until(() => recordings.length >= 2);

		expect(recordings.length).toBe(2);
		expect(recordings[0].cancelled).toBe(true);
		expect(recordings[1].options.duration).toBe(4000);
		const from = degOf(recordings[1].keyframes[0]);
		const to = degOf(recordings[1].keyframes[recordings[1].keyframes.length - 1]);
		expect(to - from).toBeGreaterThanOrEqual(1440);
	});

	test("winning segment is highlighted once the spin finishes", async () => {
		const { recordings, highlight, pulses } = mountAndStub("w-3");
		def.onTrigger?.(el("w-3"), "spin", {}, runtimeCtx("w-3"));
		mithril.redraw(true);
		await until(() => recordings.length >= 1);

		// while spinning: the highlight is not shown and no pulse is running
		expect(parseFloat(highlight.style.opacity)).toBe(0);
		expect(pulses.length).toBe(0);

		// the spin's WAAPI `onfinish` reveals the winner's segment + pulse
		recordings[0].onfinish?.();
		expect(pulses.length).toBeGreaterThanOrEqual(1);
		// the pulse loops (iterations: Infinity) so it keeps the winner glowing
		expect(pulses[0].iterations).toBe(Infinity);
		// and the resting base opacity rises to a visible value
		await until(() => parseFloat(highlight.style.opacity) > 0);
		expect(parseFloat(highlight.style.opacity)).toBeGreaterThan(0);
	});

	test("a new spin clears the previous winner's highlight", async () => {
		const { recordings, highlight, pulses } = mountAndStub("w-4");
		// first spin lands and highlights
		def.onTrigger?.(el("w-4"), "spin", {}, runtimeCtx("w-4"));
		mithril.redraw(true);
		await until(() => recordings.length >= 1);
		recordings[0].onfinish?.();
		expect(pulses.length).toBeGreaterThanOrEqual(1);
		await until(() => parseFloat(highlight.style.opacity) > 0);

		// a second spin starts: the previous winner must be cleared
		def.onTrigger?.(el("w-4"), "spin", {}, runtimeCtx("w-4"));
		mithril.redraw(true);
		await until(() => recordings.length >= 2);
		expect(parseFloat(highlight.style.opacity)).toBe(0);
	});
});
