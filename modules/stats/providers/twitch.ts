import type { PlatformStats } from "./types";

const FETCH_TIMEOUT_MS = 10_000;
const TWITCH_GQL = "https://gql.twitch.tv/gql";
const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

export async function fetchTwitchStats(
    channel: string,
): Promise<PlatformStats> {
    const res = await fetch(TWITCH_GQL, {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
            "Client-ID": TWITCH_CLIENT_ID,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            query: `query GetViewerCount($login: String!) {
                user(login: $login) {
                    stream {
                        viewersCount
                        title
                        game { name }
                    }
                }
            }`,
            variables: { login: channel },
        }),
    });
    if (!res.ok) throw new Error(`Twitch stats HTTP ${res.status}`);
    const payload = (await res.json()) as {
        errors?: { message?: string }[];
        data?: {
            user?: {
                stream?: {
                    viewersCount?: number;
                    title?: string;
                    game?: { name?: string };
                } | null;
            } | null;
        };
    };
    if (payload.errors?.length)
        throw new Error(
            `Twitch stats: ${payload.errors.map((e) => e.message ?? "query error").join("; ")}`,
        );
    const stream = payload.data?.user?.stream ?? null;
    return {
        viewers: stream?.viewersCount ?? 0,
        isLive: stream !== null,
        title: stream?.title,
        category: stream?.game?.name,
    };
}
