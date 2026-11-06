/*
 * Shared engine for the ambient canvas backgrounds.
 *
 * Every background runs the same two-canvas technique the originals used
 * (crnacura/AmbientCanvasBackgrounds): an OFFscreen canvas `a` the particles
 * paint into, and the VISIBLE canvas `b` the composited (blurred / glow)
 * frame is drawn to. The engine creates and sizes the canvases, hands a
 * background its contexts, and gives it one rAF loop helper. A background
 * is a concrete `AmbientVariant` subclass (one class per file) — adding one
 * is a class + one entry in index.ts, nothing touches the element itself.
 */

import type { OverlayElement } from "@ui/overlay/element";
import type { FormField } from "@ui/overlay/fields";
import type { PropReaders } from "../../../../../../core/overlay_element";
import { fadeCanvas, trailFade } from "./utils";

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
    /** This background's own props (see `customDefaults` on the variant) —
     * merged over its defaults by the element before calling `start`, so
     * backgrounds may tune themselves beyond the shared trio. */
    custom: Record<string, number>;
}

/** A background: one class per variant. Subclasses set `id`/`labelKey` and
 * implement `start`; they may also declare their own props
 * (`customDefaults` + `normalizeCustomProps` + `customFormRows`) for the
 * element to render and normalize. All animation-internal state lives in
 * `start`'s closure, so several instances run side by side. */
export abstract class AmbientVariant {
    /** Stable id stored in `props.kind`. */
    abstract readonly id: string;
    /** i18n key of the variant's label in the edit form. */
    abstract readonly labelKey: string;
    /** Defaults of this background's own props — stored flat in
     * `element.props`. Empty for backgrounds that only use the shared
     * `speed`/`trail`/`background` trio. */
    readonly customDefaults: Record<string, number> = {};
    /** Start the animation on `env` and return its stop function (cancels the
     * rAF loop). */
    abstract start(env: AmbientEnv, opts: AmbientOptions): () => void;
    /** Coerce this background's custom props to safe values (server-side).
     * The base has none and returns an empty record. */
    normalizeCustomProps(
        _props: Readonly<Record<string, unknown>>,
        _read: PropReaders,
    ): Record<string, number> {
        return {};
    }
    /** This background's rows in the element's edit form (rendered only when
     * it is the selected variant; one row per field). The base has none. */
    customFormRows(_element: OverlayElement): FormField[] {
        return [];
    }
}

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

/** Start of every frame: fade the offscreen layer toward transparent (so old
 * shapes linger as trails) and paint the solid background under the visible
 * canvas. Call once per frame, before drawing this frame's shapes. Pass a
 * shorter `trail` than `opts.trail` for faster-fading backgrounds (e.g.
 * `opts.trail / opts.custom.trail_faster`). */
export function beginFrame(
    env: AmbientEnv,
    opts: AmbientOptions,
    trail = opts.trail,
): void {
    fadeCanvas(env.aw, env.width, env.height, trailFade(trail));
    env.bw.fillStyle = opts.background;
    env.bw.fillRect(0, 0, env.width, env.height);
}

/** One composite pass of the offscreen canvas `a` onto the visible canvas `b`.
 * `filter` applies a CSS filter (e.g. `"blur(8px) brightness(200%)"`);
 * `lighter` composites additively for a glow. A pass with neither is a plain
 * crisp source-over blit. */
export interface GlowPass {
    /** CSS `filter` for the composite (omitted → no filter). */
    filter?: string;
    /** Additive blend (omitted → normal `source-over`). */
    lighter?: boolean;
}

/** Draw the offscreen canvas onto the visible one, once per `GlowPass`.
 * Backgrounds declare their composite look as a `readonly GlowPass[]` and call
 * this at the end of each frame, in place of hand-rolled save/filter/restore
 * blocks. */
export function compositeGlow(
    env: AmbientEnv,
    passes: readonly GlowPass[],
): void {
    for (const pass of passes) {
        env.bw.save();
        if (pass.filter) env.bw.filter = pass.filter;
        if (pass.lighter) env.bw.globalCompositeOperation = "lighter";
        env.bw.drawImage(env.a, 0, 0);
        env.bw.restore();
    }
}

/** Run `body` on a saved/restore canvas context (resets transforms + style
 * state around it). Use for any draw whose state must not leak to the next
 * shape — in particular when it uses `translate`/`rotate`. */
export function withSaved(
    ctx: CanvasRenderingContext2D,
    body: () => void,
): void {
    ctx.save();
    body();
    ctx.restore();
}
