/*
 * `shift` — large soft circles drifting, their hue cycling over time.
 * Port of `shift.js` from crnacura/AmbientCanvasBackgrounds (CC BY-SA).
 */

import type { CreateAmbient } from "./engine";
import { createFrameLoop } from "./engine";
import {
	createSimplexNoise,
	fadeCanvas,
	fadeInOut,
	hsla,
	rand,
	type SimplexNoise3D,
	TAU,
	trailFade,
} from "./utils";

const CIRCLE_COUNT = 150;
const CIRCLE_PROP_COUNT = 8;
const CIRCLE_PROPS_LENGTH = CIRCLE_COUNT * CIRCLE_PROP_COUNT;
const BASE_SPEED = 0.1;
const RANGE_SPEED = 1;
const BASE_TTL = 150;
const RANGE_TTL = 200;
const BASE_RADIUS = 100;
const RANGE_RADIUS = 200;
const RANGE_HUE = 60;
const X_OFF = 0.0015;
const Y_OFF = 0.0015;
const Z_OFF = 0.0015;
const BASE_HUE = 220;

/** Circle property stride: x, y, vx, vy, life, ttl, radius, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_RADIUS = 6;
const P_HUE = 7;

export const createShift: CreateAmbient = (env, opts) => {
	const simplex: SimplexNoise3D = createSimplexNoise();
	const circleProps = new Float32Array(CIRCLE_PROPS_LENGTH);
	let baseHue = BASE_HUE;

	function initCircle(i: number): void {
		const x = rand(env.width);
		const y = rand(env.height);
		const n = simplex.noise3D(x * X_OFF, y * Y_OFF, baseHue * Z_OFF);
		const t = rand(TAU);
		const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
		const vx = speed * Math.cos(t);
		const vy = speed * Math.sin(t);
		const ttl = BASE_TTL + rand(RANGE_TTL);
		const radius = BASE_RADIUS + rand(RANGE_RADIUS);
		const hue = baseHue + n * RANGE_HUE;
		circleProps.set([x, y, vx, vy, 0, ttl, radius, hue], i);
	}

	function drawCircle(i: number): void {
		const x = circleProps[i + P_X];
		const y = circleProps[i + P_Y];
		const life = circleProps[i + P_LIFE];
		const ttl = circleProps[i + P_TTL];
		const radius = circleProps[i + P_RADIUS];
		const hue = circleProps[i + P_HUE];
		env.aw.save();
		env.aw.fillStyle = hsla(hue, 60, 30, fadeInOut(life, ttl));
		env.aw.beginPath();
		env.aw.arc(x, y, radius, 0, TAU);
		env.aw.fill();
		env.aw.closePath();
		env.aw.restore();
	}

	function updateCircle(i: number): void {
		drawCircle(i);
		const x = circleProps[i + P_X] + circleProps[i + P_VX];
		const y = circleProps[i + P_Y] + circleProps[i + P_VY];
		const life = circleProps[i + P_LIFE] + 1;
		const ttl = circleProps[i + P_TTL];
		const radius = circleProps[i + P_RADIUS];
		circleProps[i + P_X] = x;
		circleProps[i + P_Y] = y;
		circleProps[i + P_LIFE] = life;
		const out =
			x < -radius ||
			x > env.width + radius ||
			y < -radius ||
			y > env.height + radius;
		if (out || life > ttl) initCircle(i);
	}

	for (let i = 0; i < CIRCLE_PROPS_LENGTH; i += CIRCLE_PROP_COUNT)
		initCircle(i);

	return createFrameLoop(() => {
		// Fade the offscreen layer toward transparent so the drifting orbs
		// dissolve out as trails (never a full clear, the drawing never stops).
		fadeCanvas(env.aw, env.width, env.height, trailFade(opts.trail));
		env.bw.fillStyle = opts.background;
		env.bw.fillRect(0, 0, env.width, env.height);
		baseHue++;
		for (let i = 0; i < CIRCLE_PROPS_LENGTH; i += CIRCLE_PROP_COUNT)
			updateCircle(i);
		env.bw.save();
		env.bw.filter = "blur(50px)";
		env.bw.drawImage(env.a, 0, 0);
		env.bw.restore();
	});
};
