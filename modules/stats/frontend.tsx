// Stats dashboard widget for YouTube, Twitch, and Kick channel references.

// biome-ignore lint/style/useImportType: used in JSX
import m from "mithril";
import { Badge } from "../../frontend/ts/components/ui";
import { t } from "../../frontend/ts/i18n";
import type { ServerDashboardWidget } from "../../shared/types";
import {
	parseStatsSpec,
	STATS_EDITOR_FIELDS,
	statsSeriesCapFromConfig,
	statsSpecsFromConfig,
} from "./config";
import { LineChart } from "./graph-linechart";
import { currentViewerTotal, mergeViewerSeries } from "./series";
import type { ChannelWidgetModule, StatsLive, WidgetContext } from "./types";
import "./styles.css";

const live = new Map<string, StatsLive>();

function onFrame(event: string, data: unknown): void {
	if (event === "widget.snapshot") {
		const snapshot = data as {
			stats?: Record<string, StatsLive | null>;
		};
		for (const [spec, stats] of Object.entries(snapshot.stats ?? [])) {
			if (stats) live.set(spec, stats);
			else live.delete(spec);
		}
	} else if (event === "stats.update") {
		const frame = data as { channel?: string; stats?: StatsLive };
		if (frame.channel && frame.stats) live.set(frame.channel, frame.stats);
	}
}

function configuredSpecs(w: ServerDashboardWidget): string[] {
	return statsSpecsFromConfig(w.config).filter(
		(spec): spec is string => spec !== null,
	);
}

function badge(w: ServerDashboardWidget, _ctx: WidgetContext): m.Vnode {
	const specs = configuredSpecs(w);
	if (specs.length === 0)
		return <Badge text={t("dash.widget_not_configured")} kind="warn" />;
	const samples = specs.map((spec) => live.get(spec));
	if (samples.some((sample) => sample?.isLive))
		return <Badge text={t("dev.badge.online")} kind="on" />;
	if (samples.every((sample) => sample !== undefined))
		return <Badge text={t("dev.badge.offline")} kind="off" />;
	return <Badge text={t("dash.widget_waiting")} kind="warn" />;
}

function durationMinutes(fromMs: number, toMs: number): string {
	const mins = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function body(w: ServerDashboardWidget, _ctx: WidgetContext): m.Children {
	const specs = configuredSpecs(w);
	if (specs.length === 0)
		return <p class="muted">{t("dash.widget_not_configured")}</p>;

	const samples = specs.map((spec) => live.get(spec) ?? null);
	if (samples.every((sample) => sample === null))
		return <p class="muted">{t("stats.waiting")}</p>;

	const currentTotal = currentViewerTotal(samples);
	const chartSeries = mergeViewerSeries(
		specs.flatMap((spec, index) => {
			const parsed = parseStatsSpec(spec);
			const sample = samples[index];
			return parsed && sample
				? [
						{
							key: parsed.platform,
							label: t(`stats.${parsed.platform}`),
							points: sample.series.slice(
								-statsSeriesCapFromConfig(w.config),
							),
						},
					]
				: [];
		}),
		t("stats.total"),
		samples.every((sample) => sample !== null),
	);
	const now = Math.max(0, ...samples.map((sample) => sample?.at ?? 0));
	return (
		<div class="stats">
			<div class="stats-table">
				{specs.map((spec, index) => {
					const parsed = parseStatsSpec(spec);
					if (!parsed) return <span key={spec} />;
					const sample = samples[index];
					const viewers = sample ? (sample.isLive ? sample.viewers : 0) : null;
					return (
						<div class={`stats-row stats-row-${parsed.platform}`} key={spec}>
							<span class="stats-row-label">
								{t(`stats.${parsed.platform}`)}
							</span>
							<span class="stats-row-title" title={sample?.title ?? undefined}>
								{sample?.title ?? "—"}
							</span>
							<span
								class="stats-row-category"
								title={sample?.category ?? undefined}
							>
								{sample?.category ?? "—"}
							</span>
							<span class="stats-row-duration">
								{sample?.startTime
									? durationMinutes(sample.startTime, now)
									: "—"}
							</span>
							<span class="stats-row-value">
								{viewers === null ? "—" : viewers.toLocaleString()}
							</span>
						</div>
					);
				})}
				<div class="stats-row stats-row-total">
					<span class="stats-row-label">{t("stats.total")}</span>
					<span class="stats-row-title" />
					<span class="stats-row-category" />
					<span class="stats-row-duration" />
					<span class="stats-row-value">
						{currentTotal === null ? "—" : currentTotal.toLocaleString()}
					</span>
				</div>
			</div>
			<div class="stats-spark">
				{chartSeries.some((line) => line.points.length >= 2) ? (
					<LineChart series={chartSeries} title={t("stats.chart")} />
				) : (
					<span class="muted">{t("stats.spark_pending")}</span>
				)}
			</div>
		</div>
	);
}

const statsModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "stats",
	kind: "widget",
	widgetTypes: ["stats"],
	defaultSize: { w: 4, h: 3 },
	configFields: STATS_EDITOR_FIELDS,
	body,
	badge,
	onFrame,
};

export default statsModule;
