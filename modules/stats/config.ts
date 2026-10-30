/** Platform channel parameters shared by the stats editor and hub. */
export const STATS_PLATFORMS = ["youtube", "twitch", "kick"] as const;
export type StatsPlatform = (typeof STATS_PLATFORMS)[number];

/** Default and hard maximum rolling history retained for each channel. */
export const DEFAULT_SERIES_CAP = 120;
export const MAX_SERIES_CAP = 10_000;

/** The stats widget's configurable channel references, in editor order. */
export const STATS_CONFIG_FIELDS = STATS_PLATFORMS;
export const STATS_EDITOR_FIELDS = [
    ...STATS_CONFIG_FIELDS,
    "seriesCap",
] as const;

/** The number of samples a Stats widget displays, validated from its config. */
export function statsSeriesCapFromConfig(
    config: Record<string, string> | undefined,
): number {
    const value = (config?.seriesCap ?? "").trim();
    if (!value) return DEFAULT_SERIES_CAP;
    const cap = Number(value);
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_SERIES_CAP) {
        return DEFAULT_SERIES_CAP;
    }
    return cap;
}

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

/** Hub specs are `<platform>:<channel>`. */
export function statsSpecsFromConfig(
    config: Record<string, string> | undefined,
): (string | null)[] {
    return STATS_PLATFORMS.map((platform) => {
        const configured = statsChannel(platform, config);
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
