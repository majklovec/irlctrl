/* Math helpers of the ambient backgrounds — a port of `util.js` from
 * crnacura/AmbientCanvasBackgrounds, narrowed to what the ports use. */

export const HALF_PI = 0.5 * Math.PI;
/** Full turn in radians. */
export const TAU = 2 * Math.PI;
/** Degrees to radians. */
export const TO_RAD = Math.PI / 180;
/** Random in [0, n). */
export const rand = (n: number): number => n * Math.random();
/** Random in [-n, n). */
export const randRange = (n: number): number => n - rand(2 * n);
/** Triangle wave: 0 → 1 → 0 as t runs 0 → m. */
export const fadeInOut = (t: number, m: number): number => {
	const hm = 0.5 * m;
	return Math.abs(((t + hm) % m) - hm) / hm;
};
/** Frame-lerp: n1 at speed 0, n2 at speed 1. */
export const lerp = (n1: number, n2: number, speed: number): number =>
	(1 - speed) * n1 + speed * n2;
/** Angle from (x1,y1) to (x2,y2) in radians. */
export const angle = (x1: number, y1: number, x2: number, y2: number): number =>
	Math.atan2(y2 - y1, x2 - x1);
/** hsla(); the hue is left unwrapped — the CSS parser wraps it itself. */
export const hsla = (
	hue: number,
	sat: number,
	light: number,
	alpha: number,
): string => `hsla(${hue},${sat}%,${light}%,${alpha})`;

/** Base per-frame fade strength for the OFFSCREEN canvas: the fraction of
 * the previous frame's content discarded each frame at `trail` 1. Lower
 * leaves longer, slower-dissolving trails; the drawing therefore never fully
 * stops. Fading the offscreen (not the visible) canvas keeps trails bounded
 * — a visible fade would let the additive "lighter" glow passes accumulate
 * to white. */
const TRAIL_FADE_BASE = 0.18;
/** Per-frame fade for a `trail` multiplier (1 = base speed, 10 = 10×
 * slower-fading trails; the floor keeps the strongest trail from fading
 * literally never). */
export const trailFade = (trail: number): number =>
	Math.max(TRAIL_FADE_BASE / 10, TRAIL_FADE_BASE / trail);

/** Fade a canvas TOWARD transparent by discarding `fade` of its pixels each
 * call. `destination-out` scales remaining alpha by (1-fade), so old strokes
 * linger as trails and dissolve out; unlike a coloured fill it converges to
 * fully transparent with no tinted residue. Call BEFORE drawing the new
 * frame's shapes (in place of a full clear) to keep the continuity. */
export const fadeCanvas = (
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	fade: number,
): void => {
	ctx.save();
	ctx.globalCompositeOperation = "destination-out";
	ctx.globalAlpha = 1;
	ctx.fillStyle = `rgba(0,0,0,${fade})`;
	ctx.fillRect(0, 0, width, height);
	ctx.restore();
};

/* ------------------------------------------------------------------------
 * 3D simplex noise — a port of jwagner's SimplexNoise (the copy that ships
 * with crnacura/AmbientCanvasBackgrounds), narrowed to `noise3D`, which is
 * all the ambient backgrounds use. Self-contained on purpose: the ambient
 * backgrounds must work with zero new dependencies.
 * -------------------------------------------------------------------- */

const F3 = 1 / 3;
const G3 = 1 / 6;

/** Permutation table built by a seeded shuffle (the original's default). */
function buildPermutation(): Uint8Array {
	const p = new Uint8Array(256);
	for (let i = 0; i < 256; i++) p[i] = i;
	for (let i = 255; i > 0; i--) {
		const j = (Math.random() * (i + 1)) | 0;
		const tmp = p[i];
		p[i] = p[j];
		p[j] = tmp;
	}
	return p;
}

const GRAD3 = new Float32Array([
	1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0,
	-1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/** 3D simplex noise in roughly [-1, 1]. */
function simplexNoise3D(
	perm: Uint8Array,
	permMod12: Uint8Array,
	x: number,
	y: number,
	z: number,
): number {
	const s = (x + y + z) * F3;
	const i = Math.floor(x + s);
	const j = Math.floor(y + s);
	const k = Math.floor(z + s);
	const t = (i + j + k) * G3;
	const x0 = x - (i - t);
	const y0 = y - (j - t);
	const z0 = z - (k - t);

	let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
	if (x0 >= y0) {
		if (y0 >= z0) {
			i1 = 1;
			j1 = 0;
			k1 = 0;
			i2 = 1;
			j2 = 1;
			k2 = 0;
		} else if (x0 >= z0) {
			i1 = 1;
			j1 = 0;
			k1 = 0;
			i2 = 1;
			j2 = 0;
			k2 = 1;
		} else {
			i1 = 0;
			j1 = 0;
			k1 = 1;
			i2 = 1;
			j2 = 0;
			k2 = 1;
		}
	} else {
		if (y0 < z0) {
			i1 = 0;
			j1 = 0;
			k1 = 1;
			i2 = 0;
			j2 = 1;
			k2 = 1;
		} else if (x0 < z0) {
			i1 = 0;
			j1 = 1;
			k1 = 0;
			i2 = 0;
			j2 = 1;
			k2 = 1;
		} else {
			i1 = 0;
			j1 = 1;
			k1 = 0;
			i2 = 1;
			j2 = 1;
			k2 = 0;
		}
	}

	const x1 = x0 - i1 + G3;
	const y1 = y0 - j1 + G3;
	const z1 = z0 - k1 + G3;
	const x2 = x0 - i2 + 2 * G3;
	const y2 = y0 - j2 + 2 * G3;
	const z2 = z0 - k2 + 2 * G3;
	const x3 = x0 - 1 + 3 * G3;
	const y3 = y0 - 1 + 3 * G3;
	const z3 = z0 - 1 + 3 * G3;

	const ii = i & 255;
	const jj = j & 255;
	const kk = k & 255;

	let n = 0;
	let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
	if (t0 >= 0) {
		const gi0 = permMod12[ii + perm[jj + perm[kk]]] * 3;
		t0 *= t0;
		n +=
			t0 * t0 * (GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0 + GRAD3[gi0 + 2] * z0);
	}
	let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
	if (t1 >= 0) {
		const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
		t1 *= t1;
		n +=
			t1 * t1 * (GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1 + GRAD3[gi1 + 2] * z1);
	}
	let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
	if (t2 >= 0) {
		const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
		t2 *= t2;
		n +=
			t2 * t2 * (GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2 + GRAD3[gi2 + 2] * z2);
	}
	let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
	if (t3 >= 0) {
		const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
		t3 *= t3;
		n +=
			t3 * t3 * (GRAD3[gi3] * x3 + GRAD3[gi3 + 1] * y3 + GRAD3[gi3 + 2] * z3);
	}
	return 32 * n;
}

/** One noise instance: the permutation pair every background shares. */
export interface SimplexNoise3D {
	noise3D(x: number, y: number, z: number): number;
}

export function createSimplexNoise(): SimplexNoise3D {
	const perm = buildPermutation();
	const permMod12 = new Uint8Array(512);
	for (let i = 0; i < 512; i++) {
		permMod12[i] = perm[i & 255] % 12;
	}
	return {
		noise3D: (x, y, z) => simplexNoise3D(perm, permMod12, x, y, z),
	};
}
