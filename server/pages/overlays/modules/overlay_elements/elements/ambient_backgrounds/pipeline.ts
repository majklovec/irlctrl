/*
 * `pipeline` — small glowing dots tracing circuit-like lanes through the
 * middle band of the box.
 * Port of `pipeline.js` from crnacura/AmbientCanvasBackgrounds (CC BY-SA).
 */

import { numProp, type OverlayElement } from "@ui/overlay/element";
import type { FormField } from "@ui/overlay/fields";
import type { PropReaders } from "../../../../../../core/overlay_element";
import type { CreateAmbient } from "./engine";
import { createFrameLoop } from "./engine";
import {
	fadeCanvas,
	fadeInOut,
	HALF_PI,
	hsla,
	rand,
	TAU,
	TO_RAD,
	trailFade,
} from "./utils";

const PIPE_COUNT = 30;
const PIPE_PROP_COUNT = 8;
const PIPE_PROPS_LENGTH = PIPE_COUNT * PIPE_PROP_COUNT;
const TURN_COUNT = 8;
const TURN_AMOUNT = (360 / TURN_COUNT) * TO_RAD;
const TURN_CHANCE_RANGE = 58;
const BASE_SPEED = 0.5;
const RANGE_SPEED = 1;
const BASE_TTL = 100;
const RANGE_TTL = 300;
const BASE_WIDTH = 2;
const RANGE_WIDTH = 4;
const BASE_HUE = 180;
const RANGE_HUE = 60;

/* The pipeline's own props (registered on its catalog entry, see
 * index.ts): `trail_faster` makes it fade its offscreen trails N times
 * faster than the shared base (per background), so the lane dissipates
 * right behind the moving head instead of lingering far behind it. The
 * element's `trail` multiplier still applies on top, relative to this
 * anchor. `head_brightness` scales how bright the moving head reads over
 * its base alpha (1 = original), so it can be dimmed toward the trails or
 * pushed to lead its own lane. */
export const PIPELINE_TRAIL_FASTER_MIN = 0.5;
export const PIPELINE_TRAIL_FASTER_MAX = 10;
/** 0 hides the head (trail only); the alpha stays sub-opaque well past 1,
 * since the base alpha is only 0.125. */
export const PIPELINE_HEAD_BRIGHTNESS_MIN = 0;
export const PIPELINE_HEAD_BRIGHTNESS_MAX = 4;
export const PIPELINE_CUSTOM_DEFAULTS = {
	trail_faster: 3,
	head_brightness: 1,
};

/** Normalize the pipeline's custom props (server-side, same `read` API as
 * the element's `normalizeProps`). */
export function normalizePipelineCustomProps(
	_props: Readonly<Record<string, unknown>>,
	read: PropReaders,
): Record<string, number> {
	return {
		trail_faster: read.num(
			"trail_faster",
			PIPELINE_CUSTOM_DEFAULTS.trail_faster,
			PIPELINE_TRAIL_FASTER_MIN,
			PIPELINE_TRAIL_FASTER_MAX,
		),
		head_brightness: read.num(
			"head_brightness",
			PIPELINE_CUSTOM_DEFAULTS.head_brightness,
			PIPELINE_HEAD_BRIGHTNESS_MIN,
			PIPELINE_HEAD_BRIGHTNESS_MAX,
		),
	};
}

/** The pipeline's rows in the element's edit form (shown when it is the
 * selected variant). */
export function pipelineCustomFormRow(element: OverlayElement): FormField[] {
	return [
		{
			path: "props.trail_faster",
			labelKey: "overlay.ambient_trail_faster",
			type: "number",
			value: numProp(
				element.props,
				"trail_faster",
				PIPELINE_CUSTOM_DEFAULTS.trail_faster,
			),
			min: PIPELINE_TRAIL_FASTER_MIN,
			max: PIPELINE_TRAIL_FASTER_MAX,
			step: 0.5,
		},
		{
			path: "props.head_brightness",
			labelKey: "overlay.ambient_head_brightness",
			type: "number",
			value: numProp(
				element.props,
				"head_brightness",
				PIPELINE_CUSTOM_DEFAULTS.head_brightness,
			),
			min: PIPELINE_HEAD_BRIGHTNESS_MIN,
			max: PIPELINE_HEAD_BRIGHTNESS_MAX,
			step: 0.1,
		},
	];
}

/** Pipe property stride: x, y, direction, speed, life, ttl, width, hue. */
const P_X = 0;
const P_Y = 1;
const P_DIR = 2;
const P_SPEED = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_WIDTH = 6;
const P_HUE = 7;

export const createPipeline: CreateAmbient = (env, opts) => {
	// The middle band runs along the box's longer axis: horizontal when
	// the box is wider than tall, vertical otherwise.
	const horizontal = env.width >= env.height;
	const cx = 0.5 * env.width;
	const cy = 0.5 * env.height;
	let tick = 0;
	const pipeProps = new Float32Array(PIPE_PROPS_LENGTH);

	function initPipe(i: number): void {
		const x = horizontal ? rand(env.width) : cx;
		const y = horizontal ? cy : rand(env.height);
		const angle = horizontal ? 0 : HALF_PI;
		const direction = Math.round(rand(1)) ? angle : angle + 2 * HALF_PI;
		const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
		const ttl = BASE_TTL + rand(RANGE_TTL);
		const width = BASE_WIDTH + rand(RANGE_WIDTH);
		const hue = BASE_HUE + rand(RANGE_HUE);
		pipeProps.set([x, y, direction, speed, 0, ttl, width, hue], i);
	}

	function drawPipe(i: number): void {
		const x = pipeProps[i + P_X];
		const y = pipeProps[i + P_Y];
		const life = pipeProps[i + P_LIFE];
		const ttl = pipeProps[i + P_TTL];
		const width = pipeProps[i + P_WIDTH];
		const hue = pipeProps[i + P_HUE];
		env.aw.save();
		env.aw.strokeStyle = hsla(
			hue,
			75,
			50,
			fadeInOut(life, ttl) * 0.125 * opts.custom.head_brightness,
		);
		env.aw.beginPath();
		env.aw.arc(x, y, width, 0, TAU);
		env.aw.stroke();
		env.aw.closePath();
		env.aw.restore();
	}

	function updatePipe(i: number): void {
		let x = pipeProps[i + P_X];
		let y = pipeProps[i + P_Y];
		let direction = pipeProps[i + P_DIR];
		const speed = pipeProps[i + P_SPEED];
		const life = pipeProps[i + P_LIFE];
		const ttl = pipeProps[i + P_TTL];

		drawPipe(i);

		x += Math.cos(direction) * speed;
		y += Math.sin(direction) * speed;
		const turnChance =
			!(tick % Math.max(1, Math.round(rand(TURN_CHANCE_RANGE)))) &&
			(!(Math.round(x) % 6) || !(Math.round(y) % 6));
		const turnBias = Math.round(rand(1)) ? -1 : 1;
		if (turnChance) direction += TURN_AMOUNT * turnBias;

		// Wrap the dot to the opposite edge (the original recomputed the
		// coordinates but never wrote them back — keeping its visible
		// behaviour, fixed to the wrap the bounds check intended).
		if (x > env.width) x = 0;
		if (x < 0) x = env.width;
		if (y > env.height) y = 0;
		if (y < 0) y = env.height;

		const nl = life + 1;
		pipeProps[i + P_X] = x;
		pipeProps[i + P_Y] = y;
		pipeProps[i + P_DIR] = direction;
		pipeProps[i + P_LIFE] = nl;
		if (nl > ttl) initPipe(i);
	}

	for (let i = 0; i < PIPE_PROPS_LENGTH; i += PIPE_PROP_COUNT) initPipe(i);

	return createFrameLoop(() => {
		tick++;
		// Fade the offscreen layer toward transparent so the circuit trails
		// linger and dissolve out (never a full clear, the drawing never stops).
		fadeCanvas(
			env.aw,
			env.width,
			env.height,
			trailFade(opts.trail / opts.custom.trail_faster),
		);
		for (let i = 0; i < PIPE_PROPS_LENGTH; i += PIPE_PROP_COUNT) updatePipe(i);
		env.bw.fillStyle = opts.background;
		env.bw.fillRect(0, 0, env.width, env.height);
		env.bw.save();
		env.bw.filter = "blur(12px)";
		env.bw.drawImage(env.a, 0, 0);
		env.bw.restore();
		env.bw.save();
		env.bw.drawImage(env.a, 0, 0);
		env.bw.restore();
	});
};
