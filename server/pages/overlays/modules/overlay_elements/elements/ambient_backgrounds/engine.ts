/*
 * Shared engine for the ambient canvas backgrounds.
 *
 * Every background runs the same two-canvas technique the originals used
 * (crnacura/AmbientCanvasBackgrounds): an OFFscreen canvas `a` the particles
 * paint into, and the VISIBLE canvas `b` the composited (blurred / glow)
 * frame is drawn to. The engine creates and sizes the canvases, hands a
 * background its contexts, and gives it one rAF loop helper. A background
 * implements `CreateAmbient` and returns a stop function — adding a new
 * background is one file + one entry in index.ts, nothing touches the
 * element itself.
 */

/** One running background's canvases + geometry. `b` is the canvas the
 * element's Mithril vnode owns (visible); `a` is kept out of the DOM. */
export interface AmbientEnv {
	/** Offscreen canvas — backgrounds draw their raw shapes here */
	a: HTMLCanvasElement;
	/** Visible canvas — the composited result the element displays */
	b: HTMLCanvasElement;
	/** 2d context of the offscreen canvas */
	aw: CanvasRenderingContext2D;
	/** 2d context of the visible canvas */
	bw: CanvasRenderingContext2D;
	/** Canvas width in px (the element's box) */
	width: number;
	/** Canvas height in px (the element's box) */
	height: number;
}

/** Per-instance tuning, resolved from the element's props. */
export interface AmbientOptions {
	/** 0.1–4 multiplier over the background's base motion speed */
	speed: number;
	/** 1–10 multiplier over the background's base trail fade — higher
	 * values fade each frame less, leaving longer-lasting trails */
	trail: number;
	/** Solid back colour painted under each frame */
	background: string;
	/** This background's own props (see `customDefaults` on the catalog
	 * entry) — merged over its defaults by the element before calling
	 * `create`, so backgrounds may tune themselves beyond the shared trio. */
	custom: Record<string, number>;
}

/** A background: start the animation on `env` and return its stop function
 * (cancels the rAF loop). All background-internal state lives in the
 * closure, so several instances can run side by side. */
export type CreateAmbient = (
	env: AmbientEnv,
	opts: AmbientOptions,
) => () => void;

/** Size the canvas pair. `b` is the already-mounted visible canvas; `a`
 * is a fresh offscreen canvas. Sizing a canvas clears it, so this doubles
 * as a reset on resize. */
export function createAmbientEnv(
	b: HTMLCanvasElement,
	width: number,
	height: number,
): AmbientEnv {
	const a = document.createElement("canvas");
	a.width = width;
	a.height = height;
	b.width = width;
	b.height = height;
	// A 2d context is guaranteed for a plain canvas in every browser we
	// target; fail loudly (not with a `!`) when the assumption breaks.
	const aw = a.getContext("2d");
	const bw = b.getContext("2d");
	if (!aw || !bw) throw new Error("ambient: 2d canvas context unavailable");
	return { a, b, aw, bw, width, height };
}

/** One rAF loop: `step` runs once per display frame until stopped. */
export function createFrameLoop(step: () => void): () => void {
	let frame = 0;
	const tick = (): void => {
		step();
		frame = requestAnimationFrame(tick);
	};
	frame = requestAnimationFrame(tick);
	return () => cancelAnimationFrame(frame);
}
