import m from "mithril";
import type { MithrilJSXComponent } from "../../public/ts/jsx";
import type { StatsSample } from "./types";

// ---------------------------------------------------------------------------
// Line chart
//
// SVG line chart for the viewer series, modeled on
// mithril-components/mithril-node-linechart: dashed grid, axis legends and
// circle + polyline per series. The viewBox tracks the container's pixel
// size 1:1 (via ResizeObserver), so the chart is drawn directly in screen
// pixels: resizing a card only prolongs the axes (longer lines, more grid
// rows/columns) — text size, grid spacing, margins and line thickness stay
// constant. The Y scale spans the series min→max (not 0→max) so small
// variations aren't squashed at the bottom.
// ---------------------------------------------------------------------------

/** Fallback pixel size until the first size measurement lands. */
const W_FALLBACK = 260;
const H_FALLBACK = 110;
/** Margins (px, constant at any card size) — just room for the legends. */
const M = { left: 30, right: 10, top: 12, bottom: 20 } as const;
/** Target grid line spacing (px). */
const GRID_SPACING = 28;
/** Minimum horizontal room (px) per X legend label (HH:MM / MM-DD). */
const TICK_MIN_WIDTH = 56;

type Pt = [number, number];
type State = {
    width: number | null;
    height: number | null;
    observer: ResizeObserver;
};

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

/** Compact time label: HH:MM for the current day, otherwise MM-DD. */
function timeLabel(t: number): string {
    const d = new Date(t);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = (n: number) => String(n).padStart(2, "0");
    return sameDay
        ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
        : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The line chart: `points` oldest first; Y spans the series min→max. */
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
        const { points } = vnode.attrs;
        if (!points.length)
            return <svg class={"spark"} role={"img"} aria-hidden={"true"} />;
        const n = points.length;

        // 1:1 pixel viewBox (coordinates are screen px): resizing a card only
        // prolongs the axes — the grid gains rows/columns, while text, spacing
        // and strokes keep their constant size. Legend text simply inherits the
        // widget's font size, like the rest of the design.
        const w = Math.round(vnode.state?.width ?? W_FALLBACK);
        const h = Math.round(vnode.state?.height ?? H_FALLBACK);
        const x0 = M.left,
            x1 = w - M.right;
        const y0 = M.top,
            y1 = h - M.bottom;
        if (x1 - x0 < 20 || y1 - y0 < 20)
            return <svg class={"spark"} role={"img"} aria-hidden={"true"} />;
        const gridV = Math.max(2, Math.round((x1 - x0) / GRID_SPACING));
        const gridH = Math.max(2, Math.round((y1 - y0) / GRID_SPACING));

        // Y scale: series min→max (min 1 value so an all-zero series still renders).
        const min = Math.min(...points.map((p) => p.v));
        const max = Math.max(1, ...points.map((p) => p.v));
        const span = max - min;
        const xs = (i: number) =>
            n === 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (n - 1);
        const ys = (v: number) =>
            span <= 0 ? (y0 + y1) / 2 : y1 - ((v - min) / span) * (y1 - y0);
        const pt = (i: number): Pt => [xs(i), ys(points[i]!.v)];
        const fmt = (v: number) =>
            Number.isInteger(v) ? String(v) : v.toFixed(1);

        // X legends: evenly placed ticks, as many as the card width allows.
        const tickCount =
            n < 2
                ? 1
                : Math.max(2, Math.min(5, n, Math.floor((x1 - x0) / TICK_MIN_WIDTH)));
        const xTicks: m.Children[] = [];
        for (let i = 0; i < tickCount; i++) {
            const idx =
                tickCount === 1
                    ? 0
                    : Math.round((i * (n - 1)) / (tickCount - 1));
            const [x] = pt(idx);
            xTicks.push(
                <text
                    key={`x${i}`}
                    x={x}
                    y={y1 + M.bottom - 5}
                    text-anchor={"middle"}>
                    {timeLabel(points[idx]?.t)}
                </text>,
            );
        }

        return (
            <svg
                class={"spark"}
                viewBox={`0 0 ${w} ${h}`}
                role={"img"}
                aria-label={vnode.attrs.title}>
                {[
                    // Grid (mirrors the reference's dashed grid).
                    <g class={"spark-grid"}>
                        {gridLines(gridV, gridH, x0, x1, y0, y1)}
                    </g>,
                    // Y legends: min / max of the visible series.
                    <g class={"spark-axis"}>
                        {[
                            <text key={"max"} x={x0 - 5} y={y0 + 3.5} text-anchor={"end"}>
                                {fmt(max)}
                            </text>,
                            <text key={"min"} x={x0 - 5} y={y1 + 3.5} text-anchor={"end"}>
                                {fmt(min)}
                            </text>,
                        ]}
                    </g>,
                    // X legends.
                    <g class={"spark-axis"}>{xTicks}</g>,
                    // The line itself.
                    <g class={"spark-line"}>
                        <polyline
                            points={points
                                .map((_, i) => pt(i).join(","))
                                .join(" ")}
                        />
                    </g>,
                ]}
            </svg>
        );
    },
} as MithrilJSXComponent<{ points: StatsSample[]; title?: string }, State>;
