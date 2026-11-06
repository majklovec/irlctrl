/*
 * `swirl` — fine particles pulled along a 3D simplex-noise flow field.
 * Port of `swirl.js` from crnacura/AmbientCanvasBackgrounds (CC BY-SA).
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
	randRange,
	type SimplexNoise3D,
	TAU,
	trailFade,
} from "./utils";

const PARTICLE_COUNT = 700;
const PARTICLE_PROP_COUNT = 9;
const PARTICLE_PROPS_LENGTH = PARTICLE_COUNT * PARTICLE_PROP_COUNT;
const RANGE_Y = 100;
const BASE_TTL = 50;
const RANGE_TTL = 150;
const BASE_SPEED = 0.1;
const RANGE_SPEED = 2;
const BASE_RADIUS = 1;
const RANGE_RADIUS = 4;
const BASE_HUE = 220;
const RANGE_HUE = 100;
const NOISE_STEPS = 8;
const X_OFF = 0.00125;
const Y_OFF = 0.00125;
const Z_OFF = 0.0005;

/** Particle property stride: x, y, vx, vy, life, ttl, speed, radius, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_SPEED = 6;
const P_RADIUS = 7;
const P_HUE = 8;

export class Swirl extends AmbientVariant {
	readonly id = "swirl";
	readonly labelKey = "overlay.ambient_swirl";

	start(env: AmbientEnv, opts: AmbientOptions): () => void {
		// Particles spawn in a middle band that runs along the box's longer
		// axis: horizontal when the box is wider than tall, vertical otherwise.
		const horizontalBand = env.width >= env.height;
		const cx = 0.5 * env.width;
		const cy = 0.5 * env.height;
		const simplex: SimplexNoise3D = createSimplexNoise();
		const particleProps = new Float32Array(PARTICLE_PROPS_LENGTH);
		let tick = 0;

		function initParticle(i: number): void {
			const x = horizontalBand ? rand(env.width) : cx + randRange(RANGE_Y);
			const y = horizontalBand ? cy + randRange(RANGE_Y) : rand(env.height);
			const ttl = BASE_TTL + rand(RANGE_TTL);
			const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
			const radius = BASE_RADIUS + rand(RANGE_RADIUS);
			const hue = BASE_HUE + rand(RANGE_HUE);
			particleProps.set([x, y, 0, 0, 0, ttl, speed, radius, hue], i);
		}

		function drawParticle(i: number, x2: number, y2: number): void {
			const x = particleProps[i + P_X];
			const y = particleProps[i + P_Y];
			const life = particleProps[i + P_LIFE];
			const ttl = particleProps[i + P_TTL];
			const radius = particleProps[i + P_RADIUS];
			const hue = particleProps[i + P_HUE];
			env.aw.save();
			env.aw.lineCap = "round";
			env.aw.lineWidth = radius;
			env.aw.strokeStyle = hsla(hue, 100, 60, fadeInOut(life, ttl));
			env.aw.beginPath();
			env.aw.moveTo(x, y);
			env.aw.lineTo(x2, y2);
			env.aw.stroke();
			env.aw.closePath();
			env.aw.restore();
		}

		function updateParticle(i: number): void {
			const x = particleProps[i + P_X];
			const y = particleProps[i + P_Y];
			const n =
				simplex.noise3D(x * X_OFF, y * Y_OFF, tick * Z_OFF) *
				NOISE_STEPS *
				TAU;
			const vx = lerp(particleProps[i + P_VX], Math.cos(n), 0.5);
			const vy = lerp(particleProps[i + P_VY], Math.sin(n), 0.5);
			const speed = particleProps[i + P_SPEED];
			const x2 = x + vx * speed;
			const y2 = y + vy * speed;
			drawParticle(i, x2, y2);
			const life = particleProps[i + P_LIFE] + 1;
			const ttl = particleProps[i + P_TTL];
			particleProps[i + P_X] = x2;
			particleProps[i + P_Y] = y2;
			particleProps[i + P_VX] = vx;
			particleProps[i + P_VY] = vy;
			particleProps[i + P_LIFE] = life;
			const out = x > env.width || x < 0 || y > env.height || y < 0;
			if (out || life > ttl) initParticle(i);
		}

		for (let i = 0; i < PARTICLE_PROPS_LENGTH; i += PARTICLE_PROP_COUNT)
			initParticle(i);

		return createFrameLoop(() => {
			tick++;
			// Fade the offscreen layer toward transparent so particle streaks
			// dissolve out as trails (never a full clear, the drawing never stops).
			fadeCanvas(env.aw, env.width, env.height, trailFade(opts.trail));
			env.bw.fillStyle = opts.background;
			env.bw.fillRect(0, 0, env.width, env.height);
			for (let i = 0; i < PARTICLE_PROPS_LENGTH; i += PARTICLE_PROP_COUNT)
				updateParticle(i);
			// Glow pass: two blurred "lighter" composites + a crisp one.
			env.bw.save();
			env.bw.filter = "blur(8px) brightness(200%)";
			env.bw.globalCompositeOperation = "lighter";
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
			env.bw.save();
			env.bw.filter = "blur(4px) brightness(200%)";
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
