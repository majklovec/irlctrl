/*
 * `constellation` — slow-drifting stars that twinkle and link to their
 * nearest neighbours with faint lines, like a night-sky star map.
 * Original (invented for the ambient set).
 */

import {
	AmbientVariant,
	type AmbientEnv,
	type AmbientOptions,
	createFrameLoop,
} from "./engine";
import { fadeCanvas, fadeInOut, hsla, rand, trailFade } from "./utils";

const STAR_COUNT = 90;
const STAR_PROP_COUNT = 8;
const STAR_PROPS_LENGTH = STAR_COUNT * STAR_PROP_COUNT;
const BASE_SPEED = 0.1;
const RANGE_SPEED = 0.5;
const BASE_TTL = 300;
const RANGE_TTL = 400;
const BASE_SIZE = 1;
const RANGE_SIZE = 2.5;
const BASE_HUE = 200;
const RANGE_HUE = 40;
/** Max distance below which two stars get linked, scaled to the box. */
const LINK_FRACTION = 0.16;

/** Star property stride: x, y, vx, vy, life, ttl, size, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_SIZE = 6;
const P_HUE = 7;

export class Constellation extends AmbientVariant {
	readonly id = "constellation";
	readonly labelKey = "overlay.ambient_constellation";

	start(env: AmbientEnv, opts: AmbientOptions): () => void {
		const starProps = new Float32Array(STAR_PROPS_LENGTH);
		const linkDistance = Math.min(env.width, env.height) * LINK_FRACTION;
		let tick = 0;

		function initStar(i: number): void {
			const x = rand(env.width);
			const y = rand(env.height);
			const theta = rand(Math.PI * 2);
			const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
			const vx = speed * Math.cos(theta);
			const vy = speed * Math.sin(theta);
			// Stagger lifetimes so the field never resets in one go.
			const ttl = BASE_TTL + rand(RANGE_TTL);
			const life = rand(ttl);
			const size = BASE_SIZE + rand(RANGE_SIZE);
			const hue = BASE_HUE + rand(RANGE_HUE);
			starProps.set([x, y, vx, vy, life, ttl, size, hue], i);
		}

		function drawStar(i: number): void {
			const x = starProps[i + P_X];
			const y = starProps[i + P_Y];
			const life = starProps[i + P_LIFE];
			const ttl = starProps[i + P_TTL];
			const size = starProps[i + P_SIZE];
			const hue = starProps[i + P_HUE];
			// Twinkle: a per-star sine wave on top of the life fade-in/out.
			const twinkle = 0.55 + 0.45 * Math.sin(tick * 0.05 + i);
			env.aw.save();
			env.aw.fillStyle = hsla(hue, 60, 75, fadeInOut(life, ttl) * twinkle);
			env.aw.beginPath();
			env.aw.arc(x, y, size, 0, Math.PI * 2);
			env.aw.fill();
			env.aw.closePath();
			env.aw.restore();
		}

		function updateStar(i: number): void {
			drawStar(i);
			const x2 = starProps[i + P_X] + starProps[i + P_VX];
			const y2 = starProps[i + P_Y] + starProps[i + P_VY];
			starProps[i + P_X] = x2;
			starProps[i + P_Y] = y2;
			const life = starProps[i + P_LIFE] + 1;
			starProps[i + P_LIFE] = life;
			// Wrap to the opposite edge so the field never thins out.
			if (x2 < 0) starProps[i + P_X] = env.width;
			if (x2 > env.width) starProps[i + P_X] = 0;
			if (y2 < 0) starProps[i + P_Y] = env.height;
			if (y2 > env.height) starProps[i + P_Y] = 0;
			if (life > starProps[i + P_TTL]) initStar(i);
		}

		function drawLinks(): void {
			// Connect each star to closer neighbours (i<j to draw once).
			for (let i = 0; i < STAR_PROPS_LENGTH; i += STAR_PROP_COUNT) {
				const ax = starProps[i + P_X];
				const ay = starProps[i + P_Y];
				const ahue = starProps[i + P_HUE];
				const alife = starProps[i + P_LIFE];
				const attl = starProps[i + P_TTL];
				for (let j = i + STAR_PROP_COUNT; j < STAR_PROPS_LENGTH; j += STAR_PROP_COUNT) {
					const dx = starProps[i + P_X] - starProps[j + P_X];
					const dy = starProps[i + P_Y] - starProps[j + P_Y];
					const dist = Math.hypot(dx, dy);
					if (dist > linkDistance) continue;
					const jlife = starProps[j + P_LIFE];
					const jttl = starProps[j + P_TTL];
					// Brighter when close and when both stars are in their life mid.
					const closeness = 1 - dist / linkDistance;
					const alpha =
						0.25 *
						closeness *
						fadeInOut(alife, attl) *
						fadeInOut(jlife, jttl);
					env.aw.save();
					env.aw.strokeStyle = hsla(ahue, 60, 70, alpha);
					env.aw.lineWidth = 1;
					env.aw.beginPath();
					env.aw.moveTo(ax, ay);
					env.aw.lineTo(starProps[j + P_X], starProps[j + P_Y]);
					env.aw.stroke();
					env.aw.closePath();
					env.aw.restore();
				}
			}
		}

		for (let i = 0; i < STAR_PROPS_LENGTH; i += STAR_PROP_COUNT) initStar(i);

		return createFrameLoop(() => {
			tick++;
			// Fade the offscreen layer toward transparent so links and star
			// trails dissolve out (never a full clear, the drawing stops never).
			fadeCanvas(env.aw, env.width, env.height, trailFade(opts.trail));
			env.bw.fillStyle = opts.background;
			env.bw.fillRect(0, 0, env.width, env.height);
			drawLinks();
			for (let i = 0; i < STAR_PROPS_LENGTH; i += STAR_PROP_COUNT)
				updateStar(i);
			env.bw.save();
			env.bw.filter = "blur(4px)";
			env.bw.globalCompositeOperation = "lighter";
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
		});
	}
}
