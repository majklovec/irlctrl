import type { StatsPlatform } from "../config";
import { fetchKickStats } from "./kick";
import { fetchTwitchStats } from "./twitch";
import type { PlatformStats } from "./types";
import { fetchYoutubeStats } from "./youtube";

/** Dispatch one stats poll to its platform-specific provider. */
export function fetchPlatformStats(
    platform: StatsPlatform,
    channel: string,
): Promise<PlatformStats> {
    switch (platform) {
        case "kick":
            return fetchKickStats(channel);
        case "twitch":
            return fetchTwitchStats(channel);
        case "youtube":
            return fetchYoutubeStats(channel);
        default:
            throw new Error(`Unsupported stats platform: ${String(platform)}`);
    }
}
