import { describe, expect, test } from "bun:test";
import m from "mithril";
import {
	parseStatsSpec,
	DEFAULT_SERIES_CAP,
	MAX_SERIES_CAP,
	STATS_EDITOR_FIELDS,
	statsSeriesCapFromConfig,
	statsSpecsFromConfig,
} from "../modules/stats/config";
import { currentViewerTotal, mergeViewerSeries } from "../modules/stats/series";
import type { StatsLive } from "../modules/stats/types";
import { visibleWidgetConfigFields } from "../shared/types";

describe("stats channel configuration", () => {
	test("stats editor fields render without keyed-fragment holes", () => {
		const fields = visibleWidgetConfigFields(STATS_EDITOR_FIELDS);
		const children = fields.map((field) => {
			const name = typeof field === "string" ? field : field.name;
			return m("label", { key: name }, m("input"));
		});
		expect(() => m("div", children)).not.toThrow();
		expect(fields).toEqual(["youtube", "twitch", "kick", "seriesCap"]);
	});

	test("includes a configurable series cap in the editor", () => {
		expect(STATS_EDITOR_FIELDS).toContain("seriesCap");
	});

	test("uses the default series cap when config is missing or invalid", () => {
		expect(statsSeriesCapFromConfig(undefined)).toBe(DEFAULT_SERIES_CAP);
		expect(statsSeriesCapFromConfig({ seriesCap: "0" })).toBe(
			DEFAULT_SERIES_CAP,
		);
		expect(statsSeriesCapFromConfig({ seriesCap: "1.5" })).toBe(
			DEFAULT_SERIES_CAP,
		);
		expect(
			statsSeriesCapFromConfig({ seriesCap: String(MAX_SERIES_CAP + 1) }),
		).toBe(DEFAULT_SERIES_CAP);
	});

	test("accepts valid configured series caps", () => {
		expect(statsSeriesCapFromConfig({ seriesCap: "240" })).toBe(240);
	});

	test("exposes Kick, YouTube, and Twitch in both widget config editors", () => {
		expect(STATS_EDITOR_FIELDS.slice(0, 3)).toEqual([
			"youtube",
			"twitch",
			"kick",
		]);
		expect(STATS_EDITOR_FIELDS[3]).toEqual({
			name: "channel",
			type: "hidden",
		});
	});

	test("creates one spec for each configured platform", () => {
		expect(
			statsSpecsFromConfig({
				youtube: "@Creator",
				twitch: "Streamer",
				kick: "Channel",
			}),
		).toEqual(["youtube:@Creator", "twitch:streamer", "kick:channel"]);
	});

	test("maps the legacy channel parameter to Kick", () => {
		expect(statsSpecsFromConfig({ channel: "OldChannel" })).toEqual([
			null,
			null,
			"kick:oldchannel",
		]);
	});

	test("parses platform specs without truncating channel references", () => {
		expect(parseStatsSpec("youtube:https://youtube.com/@Creator")).toEqual({
			platform: "youtube",
			channel: "https://youtube.com/@Creator",
		});
		expect(parseStatsSpec("other:channel")).toBeNull();
	});
});

describe("stats viewer totals and chart series", () => {
	test("sums available live viewers and treats offline channels as zero", () => {
		const sample = (
			platform: StatsLive["platform"],
			viewers: number,
			isLive: boolean,
		): StatsLive => ({
			platform,
			channel: "channel",
			viewers,
			isLive,
			at: 1,
			series: [],
		});
		expect(
			currentViewerTotal([
				sample("youtube", 12, true),
				sample("twitch", 0, false),
				sample("kick", 8, true),
			]),
		).toBe(20);
		expect(currentViewerTotal([null, undefined])).toBeNull();
		expect(currentViewerTotal([sample("kick", 8, true), null])).toBeNull();
	});

	test("aligns platform histories and computes a carried-forward total", () => {
		expect(
			mergeViewerSeries(
				[
					{
						key: "youtube",
						label: "YouTube",
						points: [
							{ t: 10, v: 4 },
							{ t: 30, v: 6 },
						],
					},
					{
						key: "twitch",
						label: "Twitch",
						points: [
							{ t: 20, v: 3 },
							{ t: 30, v: 5 },
						],
					},
				],
				"Total",
			),
		).toEqual([
			{
				key: "youtube",
				label: "YouTube",
				points: [
					{ t: 10, v: 4 },
					{ t: 20, v: 4 },
					{ t: 30, v: 6 },
				],
			},
			{
				key: "twitch",
				label: "Twitch",
				points: [
					{ t: 10, v: 0 },
					{ t: 20, v: 3 },
					{ t: 30, v: 5 },
				],
			},
			{
				key: "total",
				label: "Total",
				points: [
					{ t: 10, v: 4 },
					{ t: 20, v: 7 },
					{ t: 30, v: 11 },
				],
			},
		]);
	});
});
