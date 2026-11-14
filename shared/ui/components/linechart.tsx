/** @jsx m */
/**
 * Shared multi-series line chart (inline SVG, no dependencies).
 *
 * Every series is stretched across the plot width (its own x-domain), so
 * series of differing lengths never overflow; when the x-axis is shown the
 * tick labels are taken from the longest series' `t` values (ms timestamps).
 * Sizing is responsive through a ResizeObserver, falling back to a 260x110
 * viewBox before the first observation.
 */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";

export interface ChartSample {
	/** X value — ms timestamp for time series, opaque when the axis is hidden. */
	t: number;
	/** Y value (oldest first). */
	v: number;
}

export interface ChartSeries {
	/** Stable id; also drives the per-series `lc-line-{key}` CSS hook. */
	key: string;
	label: string;
	points: ChartSample[];
}

interface LineChartState {
	width: number | null;
	height: number | null;
	observer: ResizeObserver;
}

const W_FALLBACK = 260;
const H_FALLBACK = 110;
const M = { left: 44, right: 10, top: 12, bottom: 20 } as const;
const BOTTOM_NO_AXIS = 6;
const GRID_SPACING = 28;
const TICK_MIN_WIDTH = 56;

function gridLines(
	vertical: number,
	horizontal: number,
	x0: number,
	x1: number,
	y0: number,
	y1: number,
): m.Children {
	const lines: m.Children[] = [];
	for (let i = 0; i <= vertical; i++) {
		const x = x0 + (i * (x1 - x0)) / vertical;
		lines.push(<line key={`v${i}`} x1={x} x2={x} y1={y0} y2={y1} />);
	}
	for (let i = 0; i <= horizontal; i++) {
		const y = y1 - (i * (y1 - y0)) / horizontal;
		lines.push(<line key={`h${i}`} x1={x0} x2={x1} y1={y} y2={y} />);
	}
	return lines;
}

function timeLabel(t: number): string {
	const d = new Date(t);
	const sameDay = d.toDateString() === new Date().toDateString();
	const pad = (n: number) => String(n).padStart(2, "0");
	return sameDay
		? `${pad(d.getHours())}:${pad(d.getMinutes())}`
		: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Multi-series line chart; series share the y scale and plot width. */
export const LineChart = {
	oncreate(vnode) {
		const el = vnode.dom as SVGElement;
		vnode.state.width = null;
		vnode.state.height = null;
		vnode.state.observer = new ResizeObserver(() => {
			const r = el.getBoundingClientRect();
			const widthChanged =
				r.width > 0 &&
				(vnode.state.width === null ||
					Math.abs(r.width - vnode.state.width) > 0.5);
			const heightChanged =
				r.height > 0 &&
				(vnode.state.height === null ||
					Math.abs(r.height - vnode.state.height) > 0.5);
			if (widthChanged) vnode.state.width = r.width;
			if (heightChanged) vnode.state.height = r.height;
			if (widthChanged || heightChanged) void m.redraw();
		});
		vnode.state.observer.observe(el);
	},
	onremove(vnode) {
		vnode.state.observer.disconnect();
	},
	view: (vnode) => {
		const { series, title, showXAxis = true } = vnode.attrs;
		const points = series.flatMap((line) => line.points);
		if (!points.length) return <svg class="lc" role="img" aria-hidden="true" />;
		const timeline = series.reduce<ChartSample[]>(
			(longest, line) =>
				line.points.length > longest.length ? line.points : longest,
			[],
		);
		const n = timeline.length;

		const w = Math.round(vnode.state?.width ?? W_FALLBACK);
		const h = Math.round(vnode.state?.height ?? H_FALLBACK);
		const bottom = showXAxis ? M.bottom : BOTTOM_NO_AXIS;
		const x0 = M.left,
			x1 = w - M.right;
		const y0 = M.top,
			y1 = h - bottom;
		if (x1 - x0 < 20 || y1 - y0 < 20)
			return <svg class="lc" role="img" aria-hidden="true" />;
		const gridV = Math.max(2, Math.round((x1 - x0) / GRID_SPACING));
		const gridH = Math.max(2, Math.round((y1 - y0) / GRID_SPACING));
		const min = 0;
		const max = Math.max(1, ...points.map((p) => p.v));
		const xs = (i: number) =>
			n <= 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (n - 1);
		const ys = (v: number) => y1 - ((v - min) / (max - min)) * (y1 - y0);
		const fmt = (v: number) => Math.round(v).toLocaleString();
		const tickCount =
			n < 2
				? 1
				: Math.max(2, Math.min(5, n, Math.floor((x1 - x0) / TICK_MIN_WIDTH)));
		const xTicks: m.Children[] = [];
		for (let i = 0; i < tickCount; i++) {
			const idx =
				tickCount === 1 ? 0 : Math.round((i * (n - 1)) / (tickCount - 1));
			const x = xs(idx);
			xTicks.push(
				<text key={`x${i}`} x={x} y={y1 + bottom - 5} text-anchor="middle">
					{timeLabel(timeline[idx]?.t ?? 0)}
				</text>,
			);
		}

		return (
			<svg class="lc" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title}>
				{[
					<g class="lc-grid">{gridLines(gridV, gridH, x0, x1, y0, y1)}</g>,
					<g class="lc-axis">
						{[
							<text key="max" x={5} y={y0 + 3.5}>
								{fmt(max)}
							</text>,
							<text key="min" x={5} y={y1 + 3.5}>
								{fmt(min)}
							</text>,
						]}
					</g>,
					showXAxis ? <g class="lc-axis">{xTicks}</g> : null,
					<g class="lc-line">
						{series.map((line) => (
							<polyline
								key={line.key}
								class={`lc-line-${line.key}`}
								points={line.points
									.map((point, index) => [xs(index), ys(point.v)].join(","))
									.join(" ")}
							/>
						))}
					</g>,
				]}
			</svg>
		);
	},
} as MithrilJSXComponent<
	{ series: ChartSeries[]; title?: string; showXAxis?: boolean },
	LineChartState
>;
