import type { StatsLive, StatsSample } from "./types";

export interface ViewerSeries {
	key: string;
	label: string;
	points: StatsSample[];
}

interface ViewerSeriesInput {
	key: string;
	label: string;
	points: readonly StatsSample[];
}

/** Align platform histories by poll time and append their carried-forward sum. */
export function mergeViewerSeries(
	inputs: readonly ViewerSeriesInput[],
	totalLabel: string,
	includeTotal = true,
): ViewerSeries[] {
	const timeline = [
		...new Set(inputs.flatMap((series) => series.points.map((p) => p.t))),
	].sort((a, b) => a - b);
	if (timeline.length === 0) return [];

	const aligned = inputs.map((series) => {
		const points = [...series.points].sort((a, b) => a.t - b.t);
		let cursor = 0;
		let current = 0;
		return {
			key: series.key,
			label: series.label,
			points: timeline.map((t) => {
				while (cursor < points.length && points[cursor]?.t <= t) {
					current = points[cursor]?.v;
					cursor++;
				}
				return { t, v: current };
			}),
		};
	});
	if (includeTotal)
		aligned.push({
			key: "total",
			label: totalLabel,
			points: timeline.map((t, index) => ({
				t,
				v: aligned.reduce((sum, series) => sum + series.points[index]?.v, 0),
			})),
		});
	return aligned;
}

export function currentViewerTotal(
	stats: readonly (StatsLive | null | undefined)[],
): number | null {
	const available = stats.filter(
		(sample): sample is StatsLive => sample !== null && sample !== undefined,
	);
	if (available.length === 0 || available.length !== stats.length) return null;
	return available.reduce(
		(sum, sample) => sum + (sample.isLive ? sample.viewers : 0),
		0,
	);
}
