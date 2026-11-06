import { describe, expect, test } from "bun:test";
import type { AmbientEnv } from "../server/pages/overlays/modules/overlay_elements/elements/ambient_backgrounds/engine";

/**
 * Headless runs of the ambient background ports: each background is started
 * on a stubbed canvas pair and advanced a fixed number of frames, asserting
 * the loop composites to the visible canvas and never draws with NaN
 * coordinates (a broken math port would surface here as an immediate fail).
 *
 * The element module imports the browser i18n, which touches document/window
 * at import time — stub minimal globals before the dynamic import so the
 * registry loads headlessly (same convention as overlay_elements.test.ts).
 */

const FRAMES = 24;

type CtxCalls = { name: string; args: unknown[] }[];

/** A 2d context stub that records every geometry call and fails the test
 * the moment a non-finite number reaches the canvas API. `draws` counts the
 * composites to THIS canvas (drawImage). */
function makeCtx(calls: CtxCalls): {
	draws: number;
	ops: () => Record<string, unknown>;
} {
	const box: { draws: number; ops: () => Record<string, unknown> } = {
		draws: 0,
		ops: () => ({}) as Record<string, unknown>,
	};
	const check = (name: string, ...args: unknown[]): void => {
		for (const a of args)
			if (typeof a === "number" && !Number.isFinite(a))
				throw new Error(`${name}: non-finite argument`);
		calls.push({ name, args });
	};
	const ops = () =>
		({
			save() {},
			restore() {},
			clearRect: (x: number, y: number, w: number, h: number) =>
				check("clearRect", x, y, w, h),
			fillRect: (x: number, y: number, w: number, h: number) =>
				check("fillRect", x, y, w, h),
			drawImage() {
				box.draws++;
			},
			beginPath() {},
			closePath() {},
			stroke() {},
			fill() {},
			strokeRect: (x: number, y: number, w: number, h: number) =>
				check("strokeRect", x, y, w, h),
			moveTo: (x: number, y: number) => check("moveTo", x, y),
			lineTo: (x: number, y: number) => check("lineTo", x, y),
			arc: (x: number, y: number, r: number, a0: number, a1: number) =>
				check("arc", x, y, r, a0, a1),
			translate: (x: number, y: number) => check("translate", x, y),
			rotate: (a: number) => check("rotate", a),
			createLinearGradient: (
				x0: number,
				y0: number,
				x1: number,
				y1: number,
			) => {
				check("createLinearGradient", x0, y0, x1, y1);
				return { addColorStop(_offset: number, _color: string) {} };
			},
		}) as Record<string, unknown>;
	box.ops = ops;
	return box;
}

// Minimal browser globals before the element modules load.
(globalThis as Record<string, unknown>).document ??= {
	documentElement: {},
	createElement: () => ({ width: 0, height: 0 }),
};
(globalThis as Record<string, unknown>).window ??= {
	location: { origin: "http://localhost" },
};

const { AMBIENT_VARIANTS } = await import(
	"../server/pages/overlays/modules/overlay_elements/elements/ambient_backgrounds"
);
const { ambientElement, DEFAULT_AMBIENT_PROPS } = await import(
	"../server/pages/overlays/modules/overlay_elements/elements/ambient"
);

/** Run one background's rAF loop for FRAMES frames on a stubbed env, with
 * options built the way the element builds them (custom props over the
 * variant's registered defaults). */
function runFrames(v: (typeof AMBIENT_VARIANTS)[number]): {
	visibleDraws: number;
	shapeCalls: number;
} {
	let scheduled = 0;
	// rAF stub: schedule `fn` synchronously until FRAMES frames are done, so
	// the loop runs exactly FRAMES iterations in the test.
	(globalThis as Record<string, unknown>).requestAnimationFrame = (
		fn: () => void,
	): number => {
		if (scheduled >= FRAMES) return 0;
		scheduled++;
		fn();
		return scheduled;
	};
	// The loop's cleanup cancels its last frame; a no-op is enough headless.
	(globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};
	const calls: CtxCalls = [];
	const offscreen = makeCtx(calls);
	const visible = makeCtx(calls);
	const width = 800;
	const height = 450;
	const env = {
		a: { width, height },
		b: { width, height },
		aw: offscreen.ops(),
		bw: visible.ops(),
		width,
		height,
	};
	v.create(env as unknown as AmbientEnv, {
		speed: 1.5,
		trail: 1,
		background: "#05070d",
		custom: { ...v.customDefaults },
	});
	return { visibleDraws: visible.draws, shapeCalls: calls.length };
}

describe("ambient backgrounds (headless run)", () => {
	test("every variant animates and composites to the visible canvas", () => {
		expect(AMBIENT_VARIANTS.length).toBeGreaterThanOrEqual(5);
		for (const v of AMBIENT_VARIANTS) {
			const { visibleDraws, shapeCalls } = runFrames(v);
			expect(visibleDraws, `${v.id}: composites frames`).toBeGreaterThan(0);
			expect(shapeCalls, `${v.id}: draws shapes`).toBeGreaterThan(0);
		}
	});
});

describe("ambient element contract", () => {
	test("normalizeProps clamps into the safe ranges (speed, trail) and falls back on unknown kind", () => {
		const clamp = (props: Record<string, unknown>): Record<string, unknown> =>
			ambientElement.normalizeProps(props, {
				num: (k, fb, min, max) => {
					const v = props[k];
					if (typeof v === "number" && Number.isFinite(v))
						return Math.min(max, Math.max(min, v));
					return fb;
				},
				hex: (k, fb) =>
					typeof props[k] === "string"
						? (props[k] as string).toLowerCase()
						: fb,
				str: (k, fb) =>
					typeof props[k] === "string" ? (props[k] as string) : fb,
				oneOf: <T extends string>(
					k: string,
					allowed: readonly T[],
					fb: T,
				): T => {
					const v = props[k];
					return typeof v === "string" &&
						(allowed as readonly string[]).includes(v)
						? (v as T)
						: fb;
				},
				bool: (k) => props[k] === true,
			});

		expect(clamp({})).toEqual({
			kind: DEFAULT_AMBIENT_PROPS.kind,
			speed: DEFAULT_AMBIENT_PROPS.speed,
			trail: DEFAULT_AMBIENT_PROPS.trail,
			background: DEFAULT_AMBIENT_PROPS.background,
		});
		// The pipeline registers custom props: `trail_faster` clamped into
		// [0.5, 10] and `head_brightness` into [0, 4], both defaulted when
		// missing.
		expect(clamp({ kind: "pipeline", trail_faster: 99 })).toEqual({
			kind: "pipeline",
			speed: 1,
			trail: 1,
			trail_faster: 10,
			head_brightness: 1,
			background: "#05070d",
		});
		expect(clamp({ kind: "pipeline" }).trail_faster).toBe(3);
		expect(clamp({ kind: "pipeline" }).head_brightness).toBe(1);
		expect(clamp({ kind: "pipeline", head_brightness: 99 }).head_brightness).toBe(4);
		// Backgrounds without custom props normalize to just the shared trio.
		expect(clamp({ kind: "swirl", speed: 99, trail: 99 })).toEqual({
			kind: "swirl",
			speed: 4,
			trail: 10,
			background: "#05070d",
		});
		expect(clamp({ kind: "bogus" }).kind).toBe(DEFAULT_AMBIENT_PROPS.kind);
	});

	test("validate() accepts every registered variant and rejects unknown ones", () => {
		const el = (kind: string) => ({
			id: "e1",
			name: "e",
			type: "ambient",
			transform: {
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				rotation: 0,
				opacity: 1,
			},
			visible: true,
			locked: false,
			parentId: null,
			bindings: {},
			props: { kind, speed: 1, trail: 1, background: "#05070d" },
		});
		for (const v of AMBIENT_VARIANTS)
			expect(ambientElement.validate(el(v.id))).toEqual([]);
		expect(ambientElement.validate(el("bogus"))).not.toEqual([]);
	});

	test("defaultProps seed a well-formed box element", () => {
		expect(ambientElement.defaultProps).toEqual({ ...DEFAULT_AMBIENT_PROPS });
		expect(ambientElement.defaultSize.width).toBeGreaterThan(0);
		expect(ambientElement.defaultSize.height).toBeGreaterThan(0);
		expect(ambientElement.handles).toBe("box");
	});
});
