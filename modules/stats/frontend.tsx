// stats frontend — the dashboard widget for the stats channel module.
// Self-contained: owns its per-channel live map, fed by the dashboard
// websocket frames it cares about (`widget.snapshot`, `kick.stats`): current
// stream info plus a line chart of viewer counts from the server-side poller.
// The core only forwards frames (`onFrame`).

// biome-ignore lint/style/useImportType: used in JSX
import m from "mithril";
import { Badge } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import type { ServerDashboardWidget } from "../../public/types";
import { STATS_CONFIG_FIELDS } from "./backend";
import { LineChart } from "./graph-linechart";
import type {
    ChannelLive,
    ChannelWidgetModule,
    StatsLive,
    WidgetContext,
} from "./types";
import "./styles.css";

/** Live stats data per channel, accumulated from the dashboard websocket. */
const live = new Map<string, ChannelLive>();
const liveFor = (channel: string): ChannelLive => {
    let l = live.get(channel);
    if (!l) {
        l = {};
        live.set(channel, l);
    }
    return l;
};

/** Fold one dashboard-websocket frame into this module's live state; the stats
 * frames only — the chat channels' frames are ignored here. */
function onFrame(event: string, data: unknown): void {
    if (event === "widget.snapshot") {
        const snap = data as { stats?: Record<string, StatsLive | null> };
        for (const [channel, stats] of Object.entries(snap.stats ?? {}))
            liveFor(channel).stats = stats;
    } else if (event === "kick.stats") {
        const e = data as { channel?: string; stats?: StatsLive };
        if (e.channel && e.stats) liveFor(e.channel).stats = e.stats;
    }
}

/** Card head: the stream badge (not configured, waiting, else streaming/offline). */
function badge(_w: ServerDashboardWidget, ctx: WidgetContext): m.Vnode {
    const channel = ctx.channel;
    if (!channel)
        return <Badge text={t("dash.widget_not_configured")} kind="warn" />;
    const s = live.get(channel)?.stats;
    if (!s) return <Badge text={t("dash.widget_waiting")} kind="warn" />;
    return (
        <Badge
            text={s.isLive ? t("dev.badge.online") : t("dev.badge.offline")}
            kind={s.isLive ? "on" : "off"}
        />
    );
}

/** Stream duration, whole minutes ("1 h 23 min"). */
function durationMinutes(fromMs: number, toMs: number): string {
    const mins = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** The card body: stream info on top, the viewers line chart below. */
function body(_w: ServerDashboardWidget, ctx: WidgetContext): m.Children {
    const channel = ctx.channel;
    if (!channel)
        return <p class={"muted"}>{t("dash.widget_not_configured")}</p>;
    const s = live.get(channel)?.stats;
    if (!s) return <p class={"muted"}>{t("stats.waiting")}</p>;
    const now = s.at;
    return (
        <div class={"stats"}>
            {[
                <div class={"stats-top"}>
                    {[
                        <span class={"big"}>
                            {[
                                <span class={"stats-viewers"}>
                                    {(s.viewers ?? 0).toLocaleString()}
                                </span>,
                                ` ${t("stats.viewers", { count: s.viewers ?? 0 })}`,
                            ]}
                        </span>,
                        s.isLive ? (
                            <Badge text={t("stats.live")} kind="on" />
                        ) : (
                            <Badge text={t("stats.offline")} kind="off" />
                        ),
                    ]}
                </div>,
                s.title ? <p class={"stats-title"}>{s.title}</p> : null,
                <div class={"stats-meta"}>
                    {[
                        s.category ? <span>{s.category}</span> : null,
                        s.startTime ? (
                            <span
                                class={
                                    "muted"
                                }>{`${t("stats.start")} ${new Date(s.startTime).toLocaleString()}`}</span>
                        ) : null,
                        s.isLive && s.startTime ? (
                            <span
                                class={
                                    "muted"
                                }>{`${t("stats.duration")} ${durationMinutes(s.startTime, now)}`}</span>
                        ) : null,
                    ]}
                </div>,
                <div class={"stats-spark"}>
                    {[
                        s.series && s.series.length >= 2 ? (
                            <LineChart
                                points={s.series}
                                title={`${channel} — ${t("stats.chart")}`}
                                key={`c${s.series.length}`}
                            />
                        ) : (
                            <span class={"muted"}>
                                {t("stats.spark_pending")}
                            </span>
                        ),
                    ]}
                </div>,
            ]}
        </div>
    );
}

const statsModule: ChannelWidgetModule<ServerDashboardWidget> = {
    id: "stats",
    kind: "widget",
    widgetTypes: ["stats"],
    defaultSize: { w: 3, h: 2 },
    configFields: STATS_CONFIG_FIELDS,
    body,
    badge,
    onFrame,
};

export default statsModule;
