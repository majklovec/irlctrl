/** @jsx m */
/*
 * Small shared helpers for the time-driven overlay widgets (countdown, spin
 * wheel, emote wall, …). A `Ticker` component is the one idiom for "redraw me
 * every N ms while I'm on screen": it owns a `setInterval` and clears it on
 * removal, so a removed element never keeps ticking.
 */

import type { Children } from "mithril";
import m from "mithril";

export interface TickerAttrs {
	/** Redraw period in ms. */
	every: number;
	/** Re-evaluated on each tick with the current `Date.now()`. */
	render: (now: number) => Children;
}

interface TickerState {
	timer: ReturnType<typeof setInterval>;
	every: number;
	now: number;
}

/** Re-run `render(now)` every `every` ms; stops on removal. The render
 * function keeps the ticking inside the element subtree — a removed element
 * never keeps its interval alive. */
export const Ticker: m.Component<TickerAttrs, TickerState> = {
	oncreate(vnode) {
		vnode.state.now = Date.now();
		vnode.state.every = vnode.attrs.every;
		vnode.state.timer = setInterval(
			() => {
				vnode.state.now = Date.now();
				m.redraw();
			},
			vnode.attrs.every,
		);
	},
	onupdate(vnode) {
		// Period changed — restart the interval at the new rate.
		if (vnode.attrs.every !== vnode.state.every) {
			clearInterval(vnode.state.timer);
			vnode.state.every = vnode.attrs.every;
			vnode.state.timer = setInterval(
				() => {
					vnode.state.now = Date.now();
					m.redraw();
				},
				vnode.attrs.every,
			);
		}
	},
	onremove(vnode) {
		clearInterval(vnode.state.timer);
	},
	view(vnode) {
		return vnode.attrs.render(vnode.state.now);
	},
};

/** Format a milliseconds duration as `H:MM:SS` (hours only when non-zero). */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A stable pseudo-random 0..1 hash from a string (positions, jitter). */
export function hashUnit(str: string): number {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return ((h >>> 0) % 10000) / 10000;
}
