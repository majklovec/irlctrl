import type { PlatformStats } from "./types";

const FETCH_TIMEOUT_MS = 10_000;
const KICK_API = "https://kick.com/api/v1";

function parseKickTime(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const ms = Date.parse(`${value.replace(" ", "T")}Z`);
    return Number.isNaN(ms) ? undefined : ms;
}

export async function fetchKickStats(
    channel: string,
): Promise<PlatformStats> {
    const res = await fetch(
        `${KICK_API}/channels/${encodeURIComponent(channel)}`,
        {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { accept: "application/json" },
        },
    );
    if (!res.ok) throw new Error(`Kick stats HTTP ${res.status}`);
    const payload = (await res.json()) as {
        followersCount?: number;
        livestream?: {
            viewers?: number;
            is_live?: boolean;
            session_title?: string;
            start_time?: string;
            categories?: { name?: string }[];
        } | null;
    };
    const stream = payload.livestream ?? null;
    return {
        viewers: stream?.viewers ?? 0,
        followers: payload.followersCount,
        isLive: Boolean(stream?.is_live),
        title: stream?.session_title,
        category: stream?.categories?.[0]?.name,
        startTime: parseKickTime(stream?.start_time),
    };
}
