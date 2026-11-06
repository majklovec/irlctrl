/*
 * `embers` — warm flickering sparks rising through a turbulent flow field,
 * drawn as short streaks the way a fire carries them up.
 * Original (invented for the ambient set).
 */

import {
	AmbientVariant,
	type AmbientEnv,
	type AmbientOptions,
	createFrameLoop,
} from "./engine";
import {
	createSimplexNoise,
	fadeCanvas,
	fadeInOut,
	hsla,
	lerp,
	rand,
	type SimplexNoise3D,
	TAU,
	trailFade,
} from "./utils";

const EMBER_COUNT = 400;
const EMBER_PROP_COUNT = 9;
const EMBER_PROPS_LENGTH = EMBER_COUNT * EMBER_PROP_COUNT;
const BASE_TTL = 80;
const RANGE_TTL = 200;
const BASE_SPEED = 0.4;
const RANGE_SPEED = 1.6;
const BASE_RADIUS = 1;
const RANGE_RADIUS = 3;
const BASE_HUE = 10;
const RANGE_HUE = 45;
const NOISE_STEPS = 6;
const X_OFF = 0.0018;
const Y_OFF = 0.0018;
const Z_OFF = 0.0012;

/** Ember property stride: x, y, vx, vy, life, ttl, speed, radius, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_SPEED = 6;
const P_RADIUS = 7;
const P_HUE = 8;

export class Embers extends AmbientVariant {
	readonly id = "embers";
	readonly labelKey = "overlay.ambient_embers";

	start(env: AmbientEnv, opts: AmbientOptions): () => void {
		const simplex: SimplexNoise3D = createSimplexNoise();
		const emberProps = new Float32Array(EMBER_PROPS_LENGTH);
		let tick = 0;

		function initEmber(i: number): void {
			const x = rand(env.width);
			// Spawn spread through the box (lower-weighted to the bottom).
			const y = env.height * (0.5 + rand(0.6));
			const ttl = BASE_TTL + rand(RANGE_TTL);
			const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
			const radius = BASE_RADIUS + rand(RANGE_RADIUS);
			const hue = BASE_HUE + rand(RANGE_HUE);
			emberProps.set([x, y, 0, 0, 0, ttl, speed, radius, hue], i);
		}

		function drawEmber(i: number, x2: number, y2: number): void {
			const x = emberProps[i + P_X];
			const y = emberProps[i + P_Y];
			const life = emberProps[i + P_LIFE];
			const ttl = emberProps[i + P_TTL];
			const radius = emberProps[i + P_RADIUS];
			const hue = emberProps[i + P_HUE];
			// Flicker: a fast per-ember sine wave modulates brightness.
			const flicker = 0.6 + 0.4 * Math.sin(tick * 0.3 + i * 1.7);
			env.aw.save();
			env.aw.lineCap = "round";
			env.aw.lineWidth = radius;
			env.aw.strokeStyle = hsla(
				hue,
				100,
				55,
				fadeInOut(life, ttl) * flicker,
			);
			env.aw.beginPath();
			env.aw.moveTo(x, y);
			env.aw.lineTo(x2, y2);
			env.aw.stroke();
			env.aw.closePath();
			env.aw.restore();
		}

		function updateEmber(i: number): void {
			const x = emberProps[i + P_X];
			const y = emberProps[i + P_Y];
			// Turbulence field, biased upward so embers rise.
			const n =
				simplex.noise3D(x * X_OFF, y * Y_OFF, tick * Z_OFF) *
				NOISE_STEPS *
				TAU;
			const targetVx = Math.cos(n);
			const targetVy = Math.sin(n) - 1; // -1 biases upward
			const vx = lerp(emberProps[i + P_VX], targetVx, 0.4);
			const vy = lerp(emberProps[i + P_VY], targetVy, 0.4);
			const speed = emberProps[i + P_SPEED];
			const x2 = x + vx * speed;
			const y2 = y + vy * speed;
			drawEmber(i, x2, y2);
			const life = emberProps[i + P_LIFE] + 1;
			const ttl = emberProps[i + P_TTL];
			emberProps[i + P_X] = x2;
			emberProps[i + P_Y] = y2;
			emberProps[i + P_VX] = vx;
			emberProps[i + P_VY] = vy;
			emberProps[i + P_LIFE] = life;
			const out = x2 > env.width || x2 < 0 || y2 > env.height || y2 < 0;
			if (out || life > ttl) initEmber(i);
		}

		for (let i = 0; i < EMBER_PROPS_LENGTH; i += EMBER_PROP_COUNT)
			initEmber(i);

		return createFrameLoop(() => {
			tick++;
			// Fade the offscreen layer toward transparent so the spark streaks
			// dissolve out as trails (never a full clear, the drawing never stops).
			fadeCanvas(env.aw, env.width, env.height, trailFade(opts.trail));
			env.bw.fillStyle = opts.background;
			env.bw.fillRect(0, 0, env.width, env.height);
			for (let i = 0; i < EMBER_PROPS_LENGTH; i += EMBER_PROP_COUNT)
				updateEmber(i);
			// Glow pass: two blurred "lighter" composites + a crisp one.
			env.bw.save();
			env.bw.filter = "blur(6px) brightness(160%)";
			env.bw.globalCompositeOperation = "lighter";
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
			env.bw.save();
			env.bw.filter = "blur(3px) brightness(160%)";
			env.bw.globalCompositeOperation = "lighter";
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
			env.bw.save();
			env.bw.globalCompositeOperation = "lighter";
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
		});
	}
}
