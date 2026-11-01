/**
 * YouTube chat provider — polls the creator's live chat on a fixed ~1 s
 * cadence (youtube-chat-next `fetchLivePage` + a raw `get_live_chat` call via
 * `fetchChatWithActions`), ignoring YouTube's suggested `timeoutMs` throttle
 * so messages land within about a second. The raw call also returns the
 * `actions` so moderation deletes (`markChatItemAsDeletedAction`) can be turned
 * into "banned" flags, since anonymous viewers never get the banned-user event. The config value carries no `@`; the poll adds it back for the
 * handle. Offline streams make the first fetch reject — treated like a
 * disconnect and retried with backoff. The live-page fetch is part of the
 * same failure budget as the polls: a single unparseable page (a consent
 * interstitial, a mid-stream 404) is retried with backoff instead of
 * forcing a reconnect, and only five consecutive failures (or a
 * ScrapeError, whose response shape no longer parses) restart the loop,
 * since the page may have changed (e.g. the stream ended).
 */

import { RateLimitError, ScrapeError } from "youtube-chat-next";
import { fetchLivePage } from "youtube-chat-next/dist/requests";
import { parseChatData } from "youtube-chat-next/dist/parser";
import type { ChatItem } from "youtube-chat-next/dist/types/data";
import type {
    Action,
    FetchOptions,
    GetLiveChatResponse,
} from "youtube-chat-next/dist/types/yt-response";
import type { ChatLive, PublishFn } from "../types";
import { ChatProvider } from "./base";

/** Fixed poll cadence in ms (see module docs: ignore the 10 s throttle). */
const POLL_INTERVAL_MS = 1_000;
/** Shared failure budget for live-page fetches and polls: give up the loop
 * and reconnect after this many consecutive failures. */
const MAX_FAILURES = 5;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/** Curated palette of distinct, readable chat colors. YouTube's live-chat API
 * sends no per-user color, so we derive one deterministically from the
 * username; the same name always gets the same color. */
const USER_COLORS = [
    "#ff7eb6",
    "#7ee8fa",
    "#ffd166",
    "#8aff80",
    "#c792ea",
    "#ff8a65",
    "#4fc3f7",
    "#aed581",
    "#ffb74d",
    "#ba68c8",
    "#4dd0e1",
    "#f06292",
    "#9ccc65",
    "#7986cb",
    "#ffca28",
    "#26a69a",
    "#e57373",
    "#64b5f6",
];

/** Stable username display color (a palette entry, hashed from the name). */
function userNameColor(username: string): string {
    let h = 0;
    for (let i = 0; i < username.length; i++)
        h = (h * 31 + username.charCodeAt(i)) | 0;
    return USER_COLORS[Math.abs(h) % USER_COLORS.length];
}

/** Map one chat ChatItem to the wire shape (text parts joined, emoji parts
 * rendered by their unicode/label). The `@` is dropped from the name (it is a
 * handle, not the display name YouTube shows in chat) and a stable color is
 * attached for the username display. */
function asChatMessage(item: ChatItem): ChatLive | null {
    const text = item.message
        .map((part) =>
            "text" in (part as object)
                ? (part as { text: string }).text
                : (part as { emojiText: string }).emojiText,
        )
        .join("");
    const username = item.author?.name?.replace(/^@/, "") || undefined;
    return {
        id: item.id,
        username,
        text,
        ts: item.timestamp.getTime(),
        color: username ? userNameColor(username) : undefined,
    };
}

/** One `get_live_chat` action. The library's `Action` only models
 * `addChatItemAction`; a moderation delete arrives as a sibling
 * `markChatItemAsDeletedAction` that `parseChatData` discards, so widen the
 * type here to read the deleted message's id. */
type ChatAction = Action & {
    markChatItemAsDeletedAction?: { targetItemId?: string };
};

/**
 * Fetch one chat page and also return the raw `actions`.
 *
 * Anonymous viewers never receive the moderator-only `liveChatUserBanned-
 * MessageRenderer`; a mod's ban (or a single-message removal) reaches them as
 * one `markChatItemAsDeletedAction` per affected message, which the library's
 * parser drops. Its HTTP client is not exported, so we issue the same
 * `get_live_chat` call ourselves — matching its headers, timeout, and rate-
 * limit handling — and return the actions so the deleted message ids can be
 * mapped back to history and marked banned.
 */
async function fetchChatWithActions(
    options: FetchOptions,
): Promise<[ChatItem[], string, ChatAction[]]> {
    const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${options.apiKey}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            // Browser-like identity, pinned locale, and EU consent opt-out —
            // mirrors the library's private client; without these YouTube
            // serves a different or consent-walled page.
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            Cookie: "SOCS=CAI",
        },
        body: JSON.stringify({
            context: {
                client: { clientVersion: options.clientVersion, clientName: "WEB" },
            },
            continuation: options.continuation,
        }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        if (res.status === 429 || res.status === 403)
            throw new RateLimitError(
                res.status,
                parseRetryAfterMs(res.headers.get("retry-after")),
            );
        throw new Error(`youtube get_live_chat HTTP ${res.status}`);
    }
    const data = (await res.json()) as GetLiveChatResponse;
    const [items, continuation] = parseChatData(data);
    const actions = (
        data.continuationContents?.liveChatContinuation?.actions ?? []
    ) as ChatAction[];
    return [items, continuation, actions];
}

/** Parse a `Retry-After` header (delta-seconds or an HTTP-date) into ms. */
function parseRetryAfterMs(header: string | null): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        const ms = seconds * 1000;
        return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
    }
    const dateMs = Date.parse(header);
    if (Number.isNaN(dateMs)) return undefined;
    return Math.max(0, dateMs - Date.now());
}

export class YoutubeChatProvider extends ChatProvider {
    /** true while the poll loop for this channel is running */
    #polling = false;

    constructor(channel: string, publish: PublishFn) {
        super("youtube", channel, publish);
    }

    protected connect(): void {
        if (this.stopped || this.#polling) return;
        this.#polling = true;

        // The config value carries no `@` (normalized in the manager);
        // YouTube's handle does.
        const handle = this.channel.startsWith("@")
            ? this.channel
            : `@${this.channel}`;

        const loop = async (): Promise<void> => {
            const errText = (err: unknown): string =>
                err instanceof Error ? err.message : String(err);

            let options: FetchOptions | null = null;
            let failures = 0;
            // The first fetched page is YouTube's buffered history (up to ~50
            // messages, minutes old) — skip it so viewers only see fresh
            // messages arriving live, then take its continuation token.
            let live = false;

            /** Count one failure against the shared budget; resolves true when
             * the loop must give up (full reconnect). The live-page fetch and
             * the polls share this budget so a flapping page (consent
             * interstitial, mid-stream 404) doesn't restart the loop on a
             * single bad tick. */
            const fail = async (err: unknown): Promise<boolean> => {
                if (this.stopped) return true;
                // ScrapeError means the response shape no longer parses —
                // retrying won't help until a reconnect re-resolves it.
                if (err instanceof ScrapeError) {
                    this.log(
                        "scrape error",
                        `${errText(err)} (field: ${err.field})`,
                    );
                    return true;
                }
                failures += 1;
                this.log(options ? "poll" : "live page", errText(err));
                if (failures >= MAX_FAILURES) return true;
                if (err instanceof RateLimitError && err.retryAfterMs) {
                    // Honor YouTube's rate-limit ask on this tick, then
                    // resume the normal cadence.
                    await sleep(err.retryAfterMs);
                }
                return false;
            };

            while (!this.stopped) {
                // (Re)resolve the live page while no continuation is in hand.
                // An offline stream (NotLiveError) or a transient unparseable
                // page lands in the shared failure budget below.
                if (!options) {
                    try {
                        options = await fetchLivePage({ handle }, "live");
                        failures = 0;
                    } catch (err) {
                        if (await fail(err)) {
                            this.#onEnd();
                            return;
                        }
                        if (this.stopped) return;
                        await sleep(POLL_INTERVAL_MS);
                        continue;
                    }
                }

                try {
                    const [items, continuation, actions] =
                        await fetchChatWithActions(options);
                    failures = 0;
                    if (!continuation) {
                        // Empty continuation — the stream ended.
                        this.#onEnd();
                        return;
                    }
                    options.continuation = continuation;
                    if (!live) {
                        live = true;
                    } else {
                        this.setConnected(true);
                        for (const item of items) {
                            const line = asChatMessage(item);
                            if (!line) continue;
                            this.deliver(line);
                        }
                        // Anonymous viewers never get the banned-user event; a
                        // mod's ban reaches them as one
                        // `markChatItemAsDeletedAction` per deleted message. A
                        // ban clears all of a user's recent messages, so these
                        // deletions are the only "banned" signal. Each
                        // `targetItemId` equals the delivered line's id, so we
                        // batch them and mark the matching history lines.
                        const deleted: string[] = [];
                        for (const action of actions) {
                            const id =
                                action.markChatItemAsDeletedAction
                                    ?.targetItemId;
                            if (id) deleted.push(id);
                        }
                        if (deleted.length) this.markBanned(deleted);
                    }
                } catch (err) {
                    if (await fail(err)) {
                        this.#onEnd();
                        return;
                    }
                }
                // Fixed cadence. Awaiting the fetch before the next tick also
                // guarantees requests never overlap (overlapping polls would
                // race on the continuation token).
                await sleep(POLL_INTERVAL_MS);
            }
        };
        void loop();
    }

    protected teardown(): void {
        // The poll loop exits on its next `stopped` check.
    }

    /** End the poll loop (stream ended / unrecoverable failure) and reconnect. */
    #onEnd(): void {
        if (this.stopped) return;
        this.#polling = false;
        this.setConnected(false);
        this.scheduleReconnect();
    }
}
