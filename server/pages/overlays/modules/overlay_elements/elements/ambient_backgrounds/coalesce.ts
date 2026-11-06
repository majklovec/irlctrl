/*
 * `coalesce` — particles spiralling into the center.
 * Port of `coalesce.js` from crnacura/AmbientCanvasBackgrounds (CC BY-SA).
 */

import {
	AmbientVariant,
	type AmbientEnv,
	type AmbientOptions,
	createFrameLoop,
} from "./engine";
import {
	angle,
	fadeCanvas,
	fadeInOut,
	HALF_PI,
	hsla,
	lerp,
	rand,
	trailFade,
} from "./utils";

const PARTICLE_COUNT = 700;
const PARTICLE_PROP_COUNT = 9;
const PARTICLE_PROPS_LENGTH = PARTICLE_COUNT * PARTICLE_PROP_COUNT;
const BASE_TTL = 100;
const RANGE_TTL = 500;
const BASE_SPEED = 0.1;
const RANGE_SPEED = 1;
const BASE_SIZE = 2;
const RANGE_SIZE = 10;
const BASE_HUE = 10;
const RANGE_HUE = 100;

/** Particle property stride: x, y, vx, vy, life, ttl, speed, size, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_SPEED = 6;
const P_SIZE = 7;
const P_HUE = 8;

export class Coalesce extends AmbientVariant {
	readonly id = "coalesce";
	readonly labelKey = "overlay.ambient_coalesce";

	start(env: AmbientEnv, opts: AmbientOptions): () => void {
		const cx = 0.5 * env.width;
		const cy = 0.5 * env.height;
		const particleProps = new Float32Array(PARTICLE_PROPS_LENGTH);

		function initParticle(i: number): void {
			const x = rand(env.width);
			const y = rand(env.height);
			const theta = angle(x, y, cx, cy);
			const vx = Math.cos(theta) * 6;
			const vy = Math.sin(theta) * 6;
			const ttl = BASE_TTL + rand(RANGE_TTL);
			const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
			const size = BASE_SIZE + rand(RANGE_SIZE);
			const hue = BASE_HUE + rand(RANGE_HUE);
			particleProps.set([x, y, vx, vy, 0, ttl, speed, size, hue], i);
		}

		function drawParticle(
			i: number,
			theta: number,
			x: number,
			y: number,
		): void {
			const life = particleProps[i + P_LIFE];
			const ttl = particleProps[i + P_TTL];
			const size = particleProps[i + P_SIZE];
			const hue = particleProps[i + P_HUE];
			const xRel = x - 0.5 * size;
			const yRel = y - 0.5 * size;
			env.aw.save();
			env.aw.lineCap = "round";
			env.aw.lineWidth = 1;
			env.aw.strokeStyle = hsla(hue, 100, 60, fadeInOut(life, ttl));
			env.aw.beginPath();
			env.aw.translate(xRel, yRel);
			env.aw.rotate(theta);
			env.aw.translate(-xRel, -yRel);
			env.aw.strokeRect(xRel, yRel, size, size);
			env.aw.closePath();
			env.aw.restore();
		}

		function updateParticle(i: number): void {
			const x = particleProps[i + P_X];
			const y = particleProps[i + P_Y];
			const theta = angle(x, y, cx, cy) + 0.75 * HALF_PI;
			const vx = lerp(particleProps[i + P_VX], 2 * Math.cos(theta), 0.05);
			const vy = lerp(particleProps[i + P_VY], 2 * Math.sin(theta), 0.05);
			const speed = particleProps[i + P_SPEED];
			drawParticle(i, theta, x, y);
			const x2 = x + vx * speed;
			const y2 = y + vy * speed;
			const life = particleProps[i + P_LIFE] + 1;
			const ttl = particleProps[i + P_TTL];
			particleProps[i + P_X] = x2;
			particleProps[i + P_Y] = y2;
			particleProps[i + P_VX] = vx;
			particleProps[i + P_VY] = vy;
			particleProps[i + P_LIFE] = life;
			if (life > ttl) initParticle(i);
		}

		for (let i = 0; i < PARTICLE_PROPS_LENGTH; i += PARTICLE_PROP_COUNT)
			initParticle(i);

		return createFrameLoop(() => {
			// Fade the offscreen layer toward transparent (persistent trails)
			// instead of a full clear, so old particle paths dissolve out.
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
