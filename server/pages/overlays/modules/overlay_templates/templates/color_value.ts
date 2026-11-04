/*
 * Colour-with-alpha values for the `:root` var inspector: a template knob
 * like `--corner-glow: rgba(108, 92, 231, 0.4)` gets a colour picker with
 * an alpha slider (element.tsx), because the native `<input type="color">`
 * has no alpha channel. The read/write pair is the control's single
 * source of truth: `writeColorAlpha(readColorAlpha(v))` round-trips the
 * fallback exactly (alpha 1 → `rgb(r, g, b)`, else `rgba(r, g, b, a)`), so
 * editing a var back to its default drops the override like the plain
 * controls do.
 *
 * PURE on purpose (no DOM): unit-testable alongside root_vars.ts.
 */

/** A recognised colour, split into the picker's `#rrggbb` + alpha 0..1. */
export type ColorAlpha = { hex: string; alpha: number };

/** `hsl(h, s%, l%)` (per the CSS spec) to rounded 0-255 rgb. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const sn = Math.min(1, Math.max(0, s / 100));
	const ln = Math.min(1, Math.max(0, l / 100));
	const c = (1 - Math.abs(2 * ln - 1)) * sn;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const seg =
		hp < 1
			? [c, x, 0]
			: hp < 2
				? [x, c, 0]
				: hp < 3
					? [0, c, x]
					: hp < 4
						? [0, x, c]
						: hp < 5
							? [x, 0, c]
							: [c, 0, x];
	const m = ln - c / 2;
	return seg.map((v) => Math.round((v + m) * 255)) as [number, number, number];
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const hexOf = (r: number, g: number, b: number): string =>
	`#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;

/**
 * Parse one colour value into `#rrggbb` + alpha. Recognised: `rgb(..)`,
 * `rgba(..)`, `hsl(..)`, `hsla(..)`, `#rrggbb`, `#rrggbbaa`. Anything else
 * (gradients, `inherit`, …) → null, and the inspector keeps its text
 * control for that knob.
 */
export function readColorAlpha(value: string): ColorAlpha | null {
	const v = value.trim();
	const rgba =
		/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(
			v,
		);
	if (rgba) {
		const r = Number(rgba[1]);
		const g = Number(rgba[2]);
		const b = Number(rgba[3]);
		if (r > 255 || g > 255 || b > 255) return null;
		return {
			hex: hexOf(r, g, b),
			alpha: rgba[4] === undefined ? 1 : clamp01(Number(rgba[4])),
		};
	}
	const hex8 = /^#?([0-9a-f]{8})$/i.exec(v);
	if (hex8) {
		const h = hex8[1];
		return {
			hex: `#${h.slice(0, 6)}`,
			alpha: clamp01(parseInt(h.slice(6, 8), 16) / 255),
		};
	}
	const hex = /^#?([0-9a-f]{6})$/i.exec(v);
	if (hex) return { hex: `#${hex[1].toLowerCase()}`, alpha: 1 };
	const hsl =
		/^hsla?\(\s*(\d+(?:\.\d+)?)\s*,\s*([0-9.]+)%\s*,\s*([0-9.]+)%\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(
			v,
		);
	if (hsl) {
		const [r, g, b] = hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
		return {
			hex: hexOf(r, g, b),
			alpha: hsl[4] === undefined ? 1 : clamp01(Number(hsl[4])),
		};
	}
	return null;
}

/**
 * The canonical string for a picker+alpha pair: `rgb(r, g, b)` at full
 * alpha, else `rgba(r, g, b, a)` (a rounded to the slider's 2 decimals).
 * This is the exact shape the `:root` fallbacks use, so the reset-drops-
 * override contract holds.
 */
export function writeColorAlpha(hex: string, alpha: number): string {
	const h = hex.replace(/^#/, "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	const a = clamp01(alpha);
	if (a === 1) return `rgb(${r}, ${g}, ${b})`;
	return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 100) / 100})`;
}
