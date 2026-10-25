/* Isolated VU meter styled after the OBS audio mixer: a -60..0 dB scale with
 * one bar per channel (green / yellow / red zones, dimmed behind the level),
 * a peak-hold tick and dB labels underneath. The component owns its canvas and
 * its animation loop; the parent only mutates `levels` as meter events arrive. */
import m from "mithril";
import type { MithrilJSXComponent } from "../../frontend/ts/jsx";

/** Linear (0..1) magnitude and peak of one channel, as delivered by InputVolumeMeters. */
export interface VuChannel {
	mag: number;
	peak: number;
}
export interface VuLevels {
	channels: VuChannel[];
}

const MIN_DB = -60;
const WARN_DB = -20;
const ERROR_DB = -9;
const TICKS = [-60, -54, -48, -42, -36, -30, -24, -18, -12, -6, 0];

const COLORS = {
	green: "#4cff4c",
	yellow: "#ffff4c",
	red: "#ff4c4c",
	greenBg: "#267f26",
	yellowBg: "#7f7f26",
	redBg: "#7f2626",
	mutedFg: "#8a8a8a",
	mutedBg: "#444444",
	label: "#c8c8c8",
};

const toDb = (mul: number): number =>
	mul > 0 ? Math.max(MIN_DB, 20 * Math.log10(mul)) : MIN_DB;
const dbToX = (db: number, w: number): number =>
	((Math.min(0, Math.max(MIN_DB, db)) - MIN_DB) / -MIN_DB) * w;

interface Smoothed {
	mag: number;
	peak: number;
	hold: number;
}

function paint(
	c: HTMLCanvasElement,
	chans: Smoothed[],
	muted: boolean,
): void {
	const dpr = window.devicePixelRatio || 1;
	const rect = c.getBoundingClientRect();
	const W = Math.max(1, Math.round(rect.width * dpr));
	const H = Math.max(1, Math.round(rect.height * dpr));
	if (c.width !== W) c.width = W;
	if (c.height !== H) c.height = H;
	const ctx = c.getContext("2d");
	if (!ctx) return;
	ctx.clearRect(0, 0, W, H);

	const labelH = Math.round(11 * dpr);
	const padX = Math.round(14 * dpr); // room for the "-60" / "0" labels
	const barsH = H - labelH;
	const n = Math.max(1, chans.length);
	const gap = Math.round(2 * dpr);
	const barH = Math.max(1, Math.floor((barsH - gap * (n - 1)) / n));
	const w = W - 2 * padX;

	const zones: Array<[number, number, string, string]> = [
		[MIN_DB, WARN_DB, COLORS.green, COLORS.greenBg],
		[WARN_DB, ERROR_DB, COLORS.yellow, COLORS.yellowBg],
		[ERROR_DB, 0, COLORS.red, COLORS.redBg],
	];

	chans.forEach((ch, i) => {
		const y = i * (barH + gap);
		const levelX = padX + dbToX(ch.mag, w);
		for (const [from, to, fg, bg] of zones) {
			const x0 = padX + dbToX(from, w);
			const x1 = padX + dbToX(to, w);
			ctx.fillStyle = muted ? COLORS.mutedBg : bg;
			ctx.fillRect(x0, y, x1 - x0, barH);
			const fill = Math.min(levelX, x1) - x0;
			if (fill > 0) {
				ctx.fillStyle = muted ? COLORS.mutedFg : fg;
				ctx.fillRect(x0, y, fill, barH);
			}
		}
		if (ch.peak > MIN_DB) {
			const px = padX + dbToX(ch.peak, w);
			ctx.fillStyle = muted
				? COLORS.mutedFg
				: ch.peak >= ERROR_DB
					? COLORS.red
					: ch.peak >= WARN_DB
						? COLORS.yellow
						: COLORS.green;
			ctx.fillRect(Math.min(px, padX + w) - Math.max(1, dpr), y, Math.max(1, dpr), barH);
		}
	});

	ctx.fillStyle = COLORS.label;
	ctx.font = `${Math.round(9 * dpr)}px sans-serif`;
	ctx.textBaseline = "bottom";
	for (const db of TICKS) {
		const x = padX + dbToX(db, w);
		ctx.fillRect(Math.round(x), barsH, Math.max(1, Math.round(dpr)), Math.round(2 * dpr));
		const text = String(db);
		const tw = ctx.measureText(text).width;
		ctx.fillText(text, Math.min(W - tw, Math.max(0, x - tw / 2)), H);
	}
}

interface VUMeterAttrs {
	/** Mutable level source, updated by the parent on each meter event. */
	levels: VuLevels;
	muted?: boolean;
}

export const VUMeter = (() => {
	let raf = 0;
	let muted = false;
	return {
		oncreate({ dom, attrs }) {
			const canvas = dom as HTMLCanvasElement;
			let smoothed: Smoothed[] = [];
			const loop = () => {
				const src = attrs.levels.channels;
				if (smoothed.length !== src.length) {
					smoothed = src.map(() => ({ mag: MIN_DB, peak: MIN_DB, hold: 0 }));
				}
				src.forEach((ch, i) => {
					const s = smoothed[i];
					const mag = toDb(ch.mag);
					const peak = toDb(Math.max(ch.peak, ch.mag));
					s.mag = mag > s.mag ? mag : Math.max(mag, s.mag - 0.6);
					if (peak >= s.peak) {
						s.peak = peak;
						s.hold = 45;
					} else if (s.hold > 0) s.hold--;
					else s.peak = Math.max(peak, s.peak - 0.4);
				});
				paint(canvas, smoothed, muted);
				raf = requestAnimationFrame(loop);
			};
			loop();
		},
		onbeforeupdate({ attrs }) {
			muted = attrs.muted === true;
			return false;
		},
		onremove() {
			cancelAnimationFrame(raf);
		},
		view: ({ attrs }) => {
			muted = attrs.muted === true;
			return <canvas class="obs-vu" />;
		},
	} as m.Component<VUMeterAttrs>;
}) as unknown as MithrilJSXComponent<VUMeterAttrs>;
