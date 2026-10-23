/** Platform channel parameters shared by the stats editor and hub. */
export const STATS_PLATFORMS = ["youtube", "twitch", "kick"] as const;
export type StatsPlatform = (typeof STATS_PLATFORMS)[number];

/** The stats widget's configurable channel references, in editor order. */
export const STATS_CONFIG_FIELDS = STATS_PLATFORMS;
/** Keep the old singular Kick config during the transition, without showing it. */
export const STATS_EDITOR_FIELDS = [
	...STATS_CONFIG_FIELDS,
	{ name: "channel", type: "hidden" },
] as const;

const normalizeChannel = (
	platform: StatsPlatform,
	value: string | undefined,
): string => {
	const channel = (value ?? "").trim();
	return platform === "youtube" ? channel : channel.toLowerCase();
};

export function statsChannel(
	platform: StatsPlatform,
	config: Record<string, string> | undefined,
): string {
	return normalizeChannel(platform, config?.[platform]);
}

/**
 * Hub specs are `<platform>:<channel>`; the legacy `channel` field maps to
 * Kick so existing dashboards keep working until they are next edited.
 */
export function statsSpecsFromConfig(
	config: Record<string, string> | undefined,
): (string | null)[] {
	return STATS_PLATFORMS.map((platform) => {
		const configured =
			statsChannel(platform, config) ||
			(platform === "kick" && !config?.kick
				? normalizeChannel("kick", config?.channel)
				: "");
		return configured ? `${platform}:${configured}` : null;
	});
}

export function parseStatsSpec(
	spec: string,
): { platform: StatsPlatform; channel: string } | null {
	const separator = spec.indexOf(":");
	if (separator <= 0 || separator === spec.length - 1) return null;
	const platform = spec.slice(0, separator);
	if (!(STATS_PLATFORMS as readonly string[]).includes(platform)) return null;
	return {
		platform: platform as StatsPlatform,
		channel: spec.slice(separator + 1).trim(),
	};
}
