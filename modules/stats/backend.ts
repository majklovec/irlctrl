/*
 * stats backend — one server-side hub for all configured YouTube, Twitch,
 * and Kick channel references. Each source is polled independently and
 * published as a platform-tagged `stats.update` event.
 */
import {
	parseStatsSpec,
	STATS_CONFIG_FIELDS,
	statsSpecsFromConfig,
} from "./config";
import { fetchPlatformStats } from "./providers";
import {
	type ChannelSpecs,
	eventFrame,
	type PublishFn,
	type StatsLive,
	type StatsSample,
} from "./types";

export { STATS_CONFIG_FIELDS, statsSpecsFromConfig } from "./config";

export const STATS_POLL_MS = 30_000;
const HUB_CONFIG_FIELDS = [...STATS_CONFIG_FIELDS, "channel"] as const;
const SERIES_CAP = 120;

/** Per-platform-channel latest stats sample for the merged hub snapshot. */
export type StatsSnapshot = Record<string, StatsLive | null>;

type StatsChannelState = {
	spec: string;
	platform: NonNullable<ReturnType<typeof parseStatsSpec>>["platform"];
	channel: string;
	stats: StatsLive | null;
	series: StatsSample[];
	polling: boolean;
	timer: ReturnType<typeof setInterval> | null;
};

export class StatsChannelManager {
	#channels = new Map<string, StatsChannelState>();
	#publish: PublishFn;

	constructor(publish: PublishFn) {
		this.#publish = publish;
	}

	start(spec: string): void {
		if (this.#channels.has(spec)) return;
		const parsed = parseStatsSpec(spec);
		if (!parsed) {
			console.warn(`[stats] ignoring invalid channel spec: ${spec}`);
			return;
		}
		const state: StatsChannelState = {
			spec,
			...parsed,
			stats: null,
			series: [],
			polling: false,
			timer: null,
		};
		this.#channels.set(spec, state);
		void this.#poll(state);
		state.timer = setInterval(() => void this.#poll(state), STATS_POLL_MS);
	}

	stop(spec: string): void {
		const state = this.#channels.get(spec);
		if (!state) return;
		if (state.timer) clearInterval(state.timer);
		this.#channels.delete(spec);
	}

	sync(specs: ChannelSpecs): void {
		for (const spec of specs) {
			if (spec && !this.#channels.has(spec)) this.start(spec);
		}
		for (const spec of [...this.#channels.keys()]) {
			if (!specs.has(spec)) this.stop(spec);
		}
	}

	startedChannels(): string[] {
		return [...this.#channels.keys()];
	}

	snapshot(): StatsSnapshot {
		const out: StatsSnapshot = {};
		for (const [spec, state] of this.#channels) out[spec] = state.stats;
		return out;
	}

	destroy(): void {
		for (const spec of this.startedChannels()) this.stop(spec);
	}

	async #poll(state: StatsChannelState): Promise<void> {
		if (state.polling) return;
		state.polling = true;
		try {
			const sample = await fetchPlatformStats(state.platform, state.channel);
			if (this.#channels.get(state.spec) !== state) return;
			const at = Date.now();
			state.series = [
				...state.series,
				{ t: at, v: sample.isLive ? (sample.viewers ?? 0) : 0 },
			].slice(-SERIES_CAP);
			state.stats = {
				platform: state.platform,
				channel: state.channel,
				...sample,
				viewers: sample.isLive ? (sample.viewers ?? 0) : 0,
				at,
				series: [...state.series],
			};
			this.#publish(
				eventFrame("stats.update", {
					channel: state.spec,
					stats: state.stats,
				}),
			);
		} catch (err: unknown) {
			console.warn(
				`[stats ${state.spec}] poll failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			state.polling = false;
		}
	}
}

export default {
	id: "stats",
	kind: "widget" as const,
	title: "Stats",
	hub: {
		widgetType: "stats",
		snapshotKey: "stats",
		configFields: HUB_CONFIG_FIELDS,
		channelSpec: statsSpecsFromConfig,
		create: (publish: PublishFn): StatsChannelManager =>
			new StatsChannelManager(publish),
	},
};
