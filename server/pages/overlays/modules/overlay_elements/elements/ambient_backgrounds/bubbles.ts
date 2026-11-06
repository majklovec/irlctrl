/*
 * `bubbles` — round bubbles of varying size rising from the bottom, swaying
 * gently as they drift up, popping at the top.
 * Original (invented for the ambient set).
 */

import {
	AmbientVariant,
	type AmbientEnv,
	type AmbientOptions,
	createFrameLoop,
} from "./engine";
import { fadeCanvas, fadeInOut, hsla, rand, TAU, trailFade } from "./utils";

const BUBBLE_COUNT = 80;
const BUBBLE_PROP_COUNT = 10;
const BUBBLE_PROPS_LENGTH = BUBBLE_COUNT * BUBBLE_PROP_COUNT;
const BASE_SPEED = 0.4;
const RANGE_SPEED = 1.2;
const BASE_TTL = 200;
const RANGE_TTL = 300;
const BASE_RADIUS = 4;
const RANGE_RADIUS = 22;
const BASE_HUE = 180;
const RANGE_HUE = 40;
/** Horizontal sway amplitude (px) and angular frequency for each bubble. */
const SWAY_BASE = 12;
const SWAY_RANGE = 20;
const SWAY_FREQ_BASE = 0.02;
const SWAY_FREQ_RANGE = 0.03;

/** Bubble property stride: x, y, vy, life, ttl, radius, hue, swayAmp,
 * swayFreq, phase. */
const P_X = 0;
const P_Y = 1;
const P_VY = 2;
const P_LIFE = 3;
const P_TTL = 4;
const P_RADIUS = 5;
const P_HUE = 6;
const P_SWAY_AMP = 7;
const P_SWAY_FREQ = 8;
const P_PHASE = 9;

export class Bubbles extends AmbientVariant {
	readonly id = "bubbles";
	readonly labelKey = "overlay.ambient_bubbles";

	start(env: AmbientEnv, opts: AmbientOptions): () => void {
		const bubbleProps = new Float32Array(BUBBLE_PROPS_LENGTH);
		let tick = 0;

		function initBubble(i: number, spawnAtBottom: boolean): void {
			const x = rand(env.width);
			const y = spawnAtBottom
				? env.height + rand(env.height * 0.3)
				: rand(env.height);
			const vy = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
			const ttl = BASE_TTL + rand(RANGE_TTL);
			const life = spawnAtBottom ? 0 : rand(ttl);
			const radius = BASE_RADIUS + rand(RANGE_RADIUS);
			const hue = BASE_HUE + rand(RANGE_HUE);
			const swayAmp = SWAY_BASE + rand(SWAY_RANGE);
			const swayFreq = SWAY_FREQ_BASE + rand(SWAY_FREQ_RANGE);
			const phase = rand(TAU);
			bubbleProps.set(
				[x, y, vy, life, ttl, radius, hue, swayAmp, swayFreq, phase],
				i,
			);
		}

		function drawBubble(i: number): void {
			const baseX = bubbleProps[i + P_X];
			const y = bubbleProps[i + P_Y];
			const life = bubbleProps[i + P_LIFE];
			const ttl = bubbleProps[i + P_TTL];
			const radius = bubbleProps[i + P_RADIUS];
			const hue = bubbleProps[i + P_HUE];
			const swayAmp = bubbleProps[i + P_SWAY_AMP];
			const swayFreq = bubbleProps[i + P_SWAY_FREQ];
			const phase = bubbleProps[i + P_PHASE];
			// Gentle horizontal sway around the base x.
			const x = baseX + Math.sin(tick * swayFreq + phase) * swayAmp;
			env.aw.save();
			env.aw.strokeStyle = hsla(hue, 80, 65, fadeInOut(life, ttl) * 0.8);
			env.aw.lineWidth = 1.5;
			env.aw.beginPath();
			env.aw.arc(x, y, radius, 0, TAU);
			env.aw.stroke();
			// A faint specular highlight toward the upper-left of the bubble.
			const hx = x - radius * 0.35;
			const hy = y - radius * 0.35;
			env.aw.fillStyle = hsla(hue, 60, 85, fadeInOut(life, ttl) * 0.5);
			env.aw.beginPath();
			env.aw.arc(hx, hy, Math.max(0.5, radius * 0.25), 0, TAU);
			env.aw.fill();
			env.aw.closePath();
			env.aw.restore();
		}

		function updateBubble(i: number): void {
			drawBubble(i);
			const y = bubbleProps[i + P_Y] - bubbleProps[i + P_VY];
			// Keep the base x drifting a little so the column wanders.
			const x = bubbleProps[i + P_X] + (Math.random() - 0.5) * 0.2;
			bubbleProps[i + P_X] = x;
			bubbleProps[i + P_Y] = y;
			const life = bubbleProps[i + P_LIFE] + 1;
			bubbleProps[i + P_LIFE] = life;
			const out = y < -bubbleProps[i + P_RADIUS];
			if (out || life > bubbleProps[i + P_TTL]) initBubble(i, true);
		}

		// Pre-fill the field so it is populated from the first frame.
		for (let i = 0; i < BUBBLE_PROPS_LENGTH; i += BUBBLE_PROP_COUNT)
			initBubble(i, false);

		return createFrameLoop(() => {
			tick++;
			// Fade the offscreen layer toward transparent so rising trails
			// dissolve out (never a full clear, the drawing never stops).
			fadeCanvas(env.aw, env.width, env.height, trailFade(opts.trail));
			env.bw.fillStyle = opts.background;
			env.bw.fillRect(0, 0, env.width, env.height);
			for (let i = 0; i < BUBBLE_PROPS_LENGTH; i += BUBBLE_PROP_COUNT)
				updateBubble(i);
			env.bw.save();
			env.bw.filter = "blur(6px)";
			env.bw.globalCompositeOperation = "lighter";
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
			env.bw.save();
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
		});
	}
}
