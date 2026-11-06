/*
 * `aurora` — rays rising from the middle band through a noise field.
 * Port of `aurora.js` from crnacura/AmbientCanvasBackgrounds (CC BY-SA).
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
	rand,
	type SimplexNoise3D,
	trailFade,
} from "./utils";

const RAY_COUNT = 500;
const RAY_PROP_COUNT = 8;
const RAY_PROPS_LENGTH = RAY_COUNT * RAY_PROP_COUNT;
const BASE_LENGTH = 200;
const RANGE_LENGTH = 200;
const BASE_SPEED = 0.05;
const RANGE_SPEED = 0.1;
const BASE_WIDTH = 10;
const RANGE_WIDTH = 20;
const BASE_HUE = 120;
const RANGE_HUE = 60;
const BASE_TTL = 50;
const RANGE_TTL = 100;
const NOISE_STRENGTH = 100;
const X_OFF = 0.0015;
const Y_OFF = 0.0015;
const Z_OFF = 0.0015;

export class Aurora extends AmbientVariant {
	readonly id = "aurora";
	readonly labelKey = "overlay.ambient_aurora";

	start(env: AmbientEnv, opts: AmbientOptions): () => void {
		// Rays rise from a middle band that runs along the box's longer axis:
		// a horizontal band (vertical rays) when the box is wider than tall,
		// a vertical band (horizontal rays) otherwise. `coord` is the position
		// along that band, `e1`/`e2` the ray's endpoints across it.
		const horizontalBand = env.width >= env.height;
		const bandLength = horizontalBand ? env.width : env.height;
		const bandMid =
			0.5 * (horizontalBand ? env.height : env.width) + NOISE_STRENGTH;
		let tick = 0;
		const simplex: SimplexNoise3D = createSimplexNoise();
		const rayProps = new Float32Array(RAY_PROPS_LENGTH);

		function initRay(i: number): void {
			const length = BASE_LENGTH + rand(RANGE_LENGTH);
			const coord = rand(bandLength);
			let e1 = bandMid;
			let e2 = bandMid - length;
			const n =
				simplex.noise3D(coord * X_OFF, e1 * Y_OFF, tick * Z_OFF) *
				NOISE_STRENGTH;
			e1 += n;
			e2 += n;
			const ttl = BASE_TTL + rand(RANGE_TTL);
			const width = BASE_WIDTH + rand(RANGE_WIDTH);
			const sign = Math.round(rand(1)) ? 1 : -1;
			const speed = (BASE_SPEED + rand(RANGE_SPEED) * sign) * opts.speed;
			const hue = BASE_HUE + rand(RANGE_HUE);
			rayProps.set([coord, e1, e2, 0, ttl, width, speed, hue], i);
		}

		function drawRay(
			coord: number,
			e1: number,
			e2: number,
			life: number,
			ttl: number,
			width: number,
			hue: number,
		): void {
			const g = horizontalBand
				? env.aw.createLinearGradient(coord, e1, coord, e2)
				: env.aw.createLinearGradient(e1, coord, e2, coord);
			g.addColorStop(0, `hsla(${hue},100%,65%,0)`);
			g.addColorStop(0.5, `hsla(${hue},100%,65%,${fadeInOut(life, ttl)})`);
			g.addColorStop(1, `hsla(${hue},100%,65%,0)`);
			env.aw.save();
			env.aw.beginPath();
			env.aw.strokeStyle = g;
			env.aw.lineWidth = width;
			env.aw.moveTo(
				horizontalBand ? coord : e1,
				horizontalBand ? e1 : coord,
			);
			env.aw.lineTo(
				horizontalBand ? coord : e2,
				horizontalBand ? e2 : coord,
			);
			env.aw.stroke();
			env.aw.closePath();
			env.aw.restore();
		}

		function updateRay(i: number): void {
			const coord = rayProps[i];
			const e1 = rayProps[i + 1];
			const e2 = rayProps[i + 2];
			const life = rayProps[i + 3];
			const ttl = rayProps[i + 4];
			const width = rayProps[i + 5];
			const speed = rayProps[i + 6];
			const hue = rayProps[i + 7];

			drawRay(coord, e1, e2, life, ttl, width, hue);
			const ncoord = coord + speed;
			rayProps[i] = ncoord;
			rayProps[i + 3] = life + 1;
			if (ncoord < 0 || ncoord > bandLength || life + 1 > ttl) initRay(i);
		}

		function render(): void {
			env.bw.save();
			env.bw.filter = "blur(12px)";
			env.aw.globalCompositeOperation = "lighter";
			env.bw.drawImage(env.a, 0, 0);
			env.bw.restore();
		}

		for (let i = 0; i < RAY_PROPS_LENGTH; i += RAY_PROP_COUNT) initRay(i);

		return createFrameLoop(() => {
			tick++;
			// Fade the offscreen layer toward transparent so old rays dissolve
			// out as trails (never a full clear, the drawing never stops).
			fadeCanvas(env.aw, env.width, env.height, trailFade(opts.trail));
			env.bw.fillStyle = opts.background;
			env.bw.fillRect(0, 0, env.width, env.height);
			for (let i = 0; i < RAY_PROPS_LENGTH; i += RAY_PROP_COUNT)
				updateRay(i);
			render();
		});
	}
}
