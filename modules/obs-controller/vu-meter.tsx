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

/** Level zones, from quietest to loudest. */
type Zone = "green" | "yellow" | "red";

/** Colours of one zone: `fg` is the lit fill, `bg` the dimmed section behind it. */
interface ZoneColors {
	fg: string;
	bg: string;
}
type Palette = Record<Zone, ZoneColors>;

/* Muted colours are the greyscale "disabled" shades OBS uses: each zone keeps
 * its own luminance so the sections stay distinguishable. Palettes are keyed
 * by mute state so the painter picks one per frame and then indexes by zone. */
const COLORS = {
	live: {
		green: { fg: "#4cff4c", bg: "#267f26" },
		yellow: { fg: "#ffff4c", bg: "#7f7f26" },
		red: { fg: "#ff4c4c", bg: "#7f2626" },
	},
	muted: {
		green: { fg: "#a3a3a3", bg: "#5a5a5a" },
		yellow: { fg: "#d9d9d9", bg: "#757575" },
		red: { fg: "#717171", bg: "#414141" },
	},
	label: "#c8c8c8",
	magnitude: "#000000",
} satisfies { live: Palette; muted: Palette; label: string; magnitude: string };

const paletteFor = (muted: boolean): Palette =>
	muted ? COLORS.muted : COLORS.live;

/** dB ranges of each zone; `zone` keys into a {@link Palette}. */
const ZONES: ReadonlyArray<{ from: number; to: number; zone: Zone }> = [
	{ from: MIN_DB, to: WARN_DB, zone: "green" },
	{ from: WARN_DB, to: ERROR_DB, zone: "yellow" },
	{ from: ERROR_DB, to: 0, zone: "red" },
];

const zoneOf = (db: number): Zone =>
	db >= ERROR_DB ? "red" : db >= WARN_DB ? "yellow" : "green";

const toDb = (mul: number): number =>
	mul > 0 ? Math.max(MIN_DB, 20 * Math.log10(mul)) : MIN_DB;
const dbToX = (db: number, w: number): number =>
	((Math.min(0, Math.max(MIN_DB, db)) - MIN_DB) / -MIN_DB) * w;

/* Smoothing constants, mirroring OBS's VolumeMeter defaults (except the
 * 10 s maximum hold). */
/** dB/s the displayed peak falls once the signal drops ("Fast" in OBS). */
const PEAK_DECAY_DB_S = 11.76;
/** First-order time constant of the magnitude indicator, seconds. */
const MAGNITUDE_TAU_S = 0.3;
/** How long the maximum marker holds before it resets to the current peak. */
const PEAK_HOLD_MS = 10_000;

/** Displayed (smoothed) state of one channel, all in dB. */
interface Smoothed {
	/** Solid fill extent: instantaneous peak with a slow decay. */
	peak: number;
	/** RMS-ish magnitude, drawn as a dark tick inside the fill. */
	mag: number;
	/** Maximum over the hold window, drawn as a zone-coloured tick. */
	hold: number;
	holdAt: number;
}

/** Advance one channel's display state by `dt` seconds toward the new sample. */
function advance(
	s: Smoothed,
	mag: number,
	peak: number,
	dt: number,
	now: number,
): void {
	s.peak =
		peak >= s.peak ? peak : Math.max(peak, s.peak - PEAK_DECAY_DB_S * dt);
	s.mag += (mag - s.mag) * Math.min(1, (dt / MAGNITUDE_TAU_S) * 0.99);
	if (peak >= s.hold || now - s.holdAt > PEAK_HOLD_MS) {
		s.hold = peak;
		s.holdAt = now;
	}
}

/** Pixel geometry derived from the canvas size; recomputed only on resize. */
interface Layout {
	dpr: number;
	W: number;
	H: number;
	padX: number;
	barsH: number;
	gap: number;
	tick: number;
	w: number;
	/** Absolute x of each zone's left/right edge, parallel to {@link ZONES}. */
	zoneX: ReadonlyArray<readonly [number, number]>;
}

/* Owns the canvas, its 2D context and everything that can be cached between
 * frames: the layout, the static dB scale (pre-rendered to an offscreen canvas
 * since text rasterisation is the most expensive part of the frame) and the
 * pixel positions last drawn, so idle frames cost nothing. The canvas size is
 * tracked with a ResizeObserver instead of a per-frame getBoundingClientRect,
 * which would force a synchronous layout on every frame. */
class Renderer {
	private readonly ctx: CanvasRenderingContext2D | null;
	private readonly observer: ResizeObserver | null;
	private layout: Layout | null = null;
	private scale: HTMLCanvasElement | null = null;
	private cssW = 0;
	private cssH = 0;
	private sizeDirty = true;
	/** Flattened [peakX, holdX, magX] per channel as drawn last frame. */
	private drawn: Int32Array = new Int32Array(0);
	private drawnMuted = false;
	private drawnCount = -1;

	constructor(private readonly canvas: HTMLCanvasElement) {
		this.ctx = canvas.getContext("2d");
		if (typeof ResizeObserver === "function") {
			this.observer = new ResizeObserver((entries) => {
				const r = entries[0]?.contentRect;
				if (r) this.setCssSize(r.width, r.height);
			});
			this.observer.observe(canvas);
		} else {
			this.observer = null;
		}
		const rect = canvas.getBoundingClientRect();
		this.setCssSize(rect.width, rect.height);
	}

	dispose(): void {
		this.observer?.disconnect();
	}

	private setCssSize(w: number, h: number): void {
		if (w === this.cssW && h === this.cssH) return;
		this.cssW = w;
		this.cssH = h;
		this.sizeDirty = true;
	}

	private ensureLayout(): Layout | null {
		if (!this.observer) {
			// No ResizeObserver: fall back to measuring every frame.
			const rect = this.canvas.getBoundingClientRect();
			this.setCssSize(rect.width, rect.height);
		}
		const dpr = window.devicePixelRatio || 1;
		if (!this.sizeDirty && this.layout && this.layout.dpr === dpr) {
			return this.layout;
		}
		this.sizeDirty = false;
		const W = Math.max(1, Math.round(this.cssW * dpr));
		const H = Math.max(1, Math.round(this.cssH * dpr));
		if (this.canvas.width !== W) this.canvas.width = W;
		if (this.canvas.height !== H) this.canvas.height = H;
		const labelH = Math.round(11 * dpr);
		const padX = Math.round(14 * dpr); // room for the "-60" / "0" labels
		const w = W - 2 * padX;
		this.layout = {
			dpr,
			W,
			H,
			padX,
			barsH: H - labelH,
			gap: Math.round(2 * dpr),
			tick: Math.max(1, Math.round(2 * dpr)),
			w,
			zoneX: ZONES.map((z) => [padX + dbToX(z.from, w), padX + dbToX(z.to, w)]),
		};
		this.scale = this.renderScale(this.layout);
		this.drawnCount = -1; // force a full repaint
		return this.layout;
	}

	/** Pre-render the tick marks and dB labels into an offscreen canvas. */
	private renderScale(l: Layout): HTMLCanvasElement | null {
		const labelH = l.H - l.barsH;
		if (labelH <= 0) return null;
		const off = document.createElement("canvas");
		off.width = l.W;
		off.height = labelH;
		const ctx = off.getContext("2d");
		if (!ctx) return null;
		ctx.fillStyle = COLORS.label;
		ctx.font = `${Math.round(9 * l.dpr)}px sans-serif`;
		ctx.textBaseline = "bottom";
		const tickW = Math.max(1, Math.round(l.dpr));
		const tickH = Math.round(2 * l.dpr);
		for (const db of TICKS) {
			const x = l.padX + dbToX(db, l.w);
			ctx.fillRect(Math.round(x), 0, tickW, tickH);
			const text = String(db);
			const tw = ctx.measureText(text).width;
			ctx.fillText(text, Math.min(l.W - tw, Math.max(0, x - tw / 2)), labelH);
		}
		return off;
	}

	paint(chans: Smoothed[], muted: boolean): void {
		const ctx = this.ctx;
		const l = this.ensureLayout();
		if (!ctx || !l) return;

		const n = chans.length;
		if (this.drawn.length < n * 3) this.drawn = new Int32Array(n * 3);
		const drawn = this.drawn;

		// Quantise to device pixels and bail out if nothing visible changed.
		let dirty = muted !== this.drawnMuted || n !== this.drawnCount;
		for (let i = 0; i < n; i++) {
			const ch = chans[i];
			const px = Math.round(dbToX(ch.peak, l.w));
			const hx = Math.round(dbToX(ch.hold, l.w));
			const mx = Math.round(dbToX(ch.mag, l.w));
			const j = i * 3;
			if (drawn[j] !== px || drawn[j + 1] !== hx || drawn[j + 2] !== mx) {
				dirty = true;
				drawn[j] = px;
				drawn[j + 1] = hx;
				drawn[j + 2] = mx;
			}
		}
		if (!dirty) return;
		this.drawnMuted = muted;
		this.drawnCount = n;

		const { W, H, padX, barsH, gap, tick, w, zoneX } = l;
		ctx.clearRect(0, 0, W, H);
		if (this.scale) ctx.drawImage(this.scale, 0, barsH);

		const palette = paletteFor(muted);
		const rows = Math.max(1, n);
		const barH = Math.max(1, Math.floor((barsH - gap * (rows - 1)) / rows));
		const right = padX + w;

		for (let i = 0; i < n; i++) {
			const ch = chans[i];
			const y = i * (barH + gap);
			// As in OBS: the solid fill reaches the (decaying) peak, not the magnitude.
			const peakX = padX + dbToX(ch.peak, w);
			for (let z = 0; z < ZONES.length; z++) {
				const [x0, x1] = zoneX[z];
				const colors = palette[ZONES[z].zone];
				ctx.fillStyle = colors.bg;
				ctx.fillRect(x0, y, x1 - x0, barH);
				const fill = Math.min(peakX, x1) - x0;
				if (fill > 0) {
					ctx.fillStyle = colors.fg;
					ctx.fillRect(x0, y, fill, barH);
				}
			}
			// Maximum marker: a tick in the colour of the zone it sits in.
			const holdX = padX + dbToX(ch.hold, w);
			if (holdX - tick >= padX) {
				ctx.fillStyle = palette[zoneOf(ch.hold)].fg;
				ctx.fillRect(Math.min(holdX, right) - tick, y, tick, barH);
			}
			// Magnitude: a dark tick inside the fill.
			const magX = padX + dbToX(ch.mag, w);
			if (magX - tick >= padX) {
				ctx.fillStyle = COLORS.magnitude;
				ctx.fillRect(magX - tick, y, tick, barH);
			}
		}
	}
}

interface VUMeterAttrs {
	/** Mutable level source, updated by the parent on each meter event. */
	levels: VuLevels;
	muted?: boolean;
}

interface VUMeterState {
	raf: number;
	latest: VUMeterAttrs;
	renderer: Renderer | null;
}

/* Per-instance state lives on the vnode, so several meters never share a loop
 * or attrs. The loop reads the latest attrs each frame: muting only recolours,
 * levels keep moving. */
export const VUMeter = {
	oninit(vnode) {
		const st = vnode.state as VUMeterState;
		st.latest = vnode.attrs;
		st.raf = 0;
		st.renderer = null;
	},
	oncreate(vnode) {
		const st = vnode.state as VUMeterState;
		const renderer = new Renderer(vnode.dom as HTMLCanvasElement);
		st.renderer = renderer;
		let smoothed: Smoothed[] = [];
		let last = performance.now();
		const loop = () => {
			const now = performance.now();
			const dt = Math.min(0.25, (now - last) / 1000);
			last = now;
			const src = st.latest.levels.channels;
			const n = src.length;
			if (smoothed.length !== n) {
				smoothed = [];
				for (let i = 0; i < n; i++) {
					smoothed.push({ peak: MIN_DB, mag: MIN_DB, hold: MIN_DB, holdAt: now });
				}
			}
			for (let i = 0; i < n; i++) {
				const ch = src[i];
				advance(
					smoothed[i],
					toDb(ch.mag),
					toDb(Math.max(ch.peak, ch.mag)),
					dt,
					now,
				);
			}
			renderer.paint(smoothed, st.latest.muted === true);
			st.raf = requestAnimationFrame(loop);
		};
		loop();
	},
	onremove(vnode) {
		const st = vnode.state as VUMeterState;
		cancelAnimationFrame(st.raf);
		st.renderer?.dispose();
		st.renderer = null;
	},
	view(vnode) {
		(vnode.state as VUMeterState).latest = vnode.attrs;
		return <canvas class="obs-vu" />;
	},
} as m.Component<VUMeterAttrs> as unknown as MithrilJSXComponent<VUMeterAttrs>;
