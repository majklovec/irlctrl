/*
 * `ripple` — sonar-like rings that expand from scattering origins and fade
 * as they grow, like raindrops striking still water.
 * Original (invented for the ambient set).
 */

import {
	AmbientVariant,
	type AmbientEnv,
	type AmbientOptions,
	createFrameLoop,
} from "./engine";
import { fadeCanvas, fadeInOut, hsla, rand, TAU, trailFade } from "./utils";

const RIPPLE_COUNT = 40;
const RIPPLE_PROP_COUNT = 7;
const RIPPLE_PROPS_LENGTH = RIPPLE_COUNT * RIPPLE_PROP_COUNT;
const BASE_TTL = 160;
const RANGE_TTL = 160;
/** Radius the ring has reached at end of life, scaled to the box. */
const MAX_RADIUS_FRACTION = 0.35;
const BASE_HUE = 165;
const RANGE_HUE = 40;
/** Concentric rings drawn per ripple (outermost to a couple of inner ones),
 * each a fraction of the leading ring's radius. */
const RING_FRACTIONS = [1, 0.66, 0.4];

/** Ripple property stride: x, y, life, ttl, expansion, width, hue. */
const P_X = 0;
const P_Y = 1;
const P_LIFE = 2;
const P_TTL = 3;
const P_EXPANSION = 4;
const P_WIDTH = 5;
const P_HUE = 6;

export class Ripple extends AmbientVariant {
	readonly id = "ripple";
	readonly labelKey = "overlay.ambient_ripple";

	start(env: AmbientEnv, opts: AmbientOptions): () => void {
		const rippleProps = new Float32Array(RIPPLE_PROPS_LENGTH);
		const maxRadius =
			Math.min(env.width, env.height) * MAX_RADIUS_FRACTION;

		function initRipple(i: number, stagger: boolean): void {
			const x = rand(env.width);
			const y = rand(env.height);
			const ttl = BASE_TTL + rand(RANGE_TTL);
			const life = stagger ? rand(ttl) : 0;
			// Rings must reach maxRadius by the end of their life.
			const expansion = (maxRadius / ttl) * opts.speed;
			const width = 1 + rand(2);
			const hue = BASE_HUE + rand(RANGE_HUE);
			rippleProps.set([x, y, life, ttl, expansion, width, hue], i);
		}

		function drawRipple(i: number): void {
			const x = rippleProps[i + P_X];
			const y = rippleProps[i + P_Y];
			const life = rippleProps[i + P_LIFE];
			const ttl = rippleProps[i + P_TTL];
			const expansion = rippleProps[i + P_EXPANSION];
			const width = rippleProps[i + P_WIDTH];
			const hue = rippleProps[i + P_HUE];
			const radius = life * expansion;
			if (radius < 0.5) return;
			const fade = fadeInOut(life, ttl);
			for (const f of RING_FRACTIONS) {
				const r = radius * f;
				env.aw.save();
				env.aw.strokeStyle = hsla(hue, 80, 60, fade * 0.4 * f);
				env.aw.lineWidth = width * f;
				env.aw.beginPath();
				env.aw.arc(x, y, r, 0, TAU);
				env.aw.stroke();
				env.aw.closePath();
				env.aw.restore();
			}
		}

		function updateRipple(i: number): void {
			drawRipple(i);
			const life = rippleProps[i + P_LIFE] + 1;
			rippleProps[i + P_LIFE] = life;
			if (life > rippleProps[i + P_TTL]) initRipple(i, true);
		}

		// Stagger lifetimes so ripples erupt continuously, not in unison.
		for (let i = 0; i < RIPPLE_PROPS_LENGTH; i += RIPPLE_PROP_COUNT)
			initRipple(i, true);

		return createFrameLoop(() => {
			// Fade the offscreen layer toward transparent so old rings dissolve
			// out (never a full clear, the drawing never stops).
			fadeCanvas(env.aw, env.width, env.height, trailFade(opts.trail));
			env.bw.fillStyle = opts.background;
			env.bw.fillRect(0, 0, env.width, env.height);
			for (let i = 0; i < RIPPLE_PROPS_LENGTH; i += RIPPLE_PROP_COUNT)
				updateRipple(i);
			env.bw.save();
			env.bw.filter = "blur(3px)";
			env.bw.globalCompositeOperation = "lighter";
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
			env.bw.save();
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
		});
	}
}
