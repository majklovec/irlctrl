import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
    Action,
    AuthorBadge,
} from "youtube-chat-next/dist/types/yt-response";
import type { ChatLive } from "../server/modules/chat/types";
import {
    badgesByItemId,
    parseYtBadges,
} from "../server/modules/chat/providers/youtube_badges";

const originalFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Fixture builders -------------------------------------------------------

const acc = (label: string) => ({ accessibilityData: { label } });

const memberBadge = (tooltip = "Nový člen"): AuthorBadge => ({
    liveChatAuthorBadgeRenderer: {
        customThumbnail: {
            thumbnails: [
                { url: "https://yt3.ggpht.com/member=s16", width: 16 },
                { url: "https://yt3.ggpht.com/member=s32", width: 32 },
            ],
        },
        tooltip,
        accessibility: acc(tooltip),
    },
});

const roleBadge = (iconType: string, tooltip: string): AuthorBadge => ({
    liveChatAuthorBadgeRenderer: {
        icon: { iconType },
        tooltip,
        accessibility: acc(tooltip),
    },
});

const textAction = (id: string, authorBadges?: AuthorBadge[]): Action => ({
    addChatItemAction: {
        item: {
            liveChatTextMessageRenderer: {
                authorName: { simpleText: authorBadges ? "@User" : "@anon" },
                authorPhoto: { thumbnails: [] },
                authorBadges,
                contextMenuEndpoint: {
                    clickTrackingParams: "",
                    commandMetadata: { webCommandMetadata: { ignoreNavigation: true } },
                    liveChatItemContextMenuEndpoint: { params: "" },
                },
                id,
                timestampUsec: "1000000",
                authorExternalChannelId: "ch1",
                contextMenuAccessibility: acc("menu"),
                message: { runs: [{ text: "hi" }] },
            },
        },
        clientId: `c-${id}`,
    },
});

// --- Pure parsing: parseYtBadges --------------------------------------------

describe("parseYtBadges", () => {
    test("membership badge uses its own art (smallest thumbnail) + label", () => {
        const badges = parseYtBadges([memberBadge("Nový člen")]);
        expect(badges).toHaveLength(1);
        expect(badges?.[0]).toEqual({
            type: "member",
            text: "Nový člen",
            url: "https://yt3.ggpht.com/member=s16",
        });
    });

    test("role badges map to inline-SVG data-URIs with their tooltip", () => {
        const badges = parseYtBadges([
            roleBadge("OWNER", "Owner"),
            roleBadge("MODERATOR", "Moderátor"),
            roleBadge("VERIFIED_CHANNEL", "Verified channel"),
            roleBadge("HOST", "Host"),
        ]);
        expect(badges).toHaveLength(4);
        expect(badges?.[0]).toMatchObject({
            type: "owner",
            text: "Owner",
        });
        expect(badges?.[1]).toMatchObject({ type: "moderator", text: "Moderátor" });
        for (const b of badges ?? [])
            expect(b.url?.startsWith("data:image/svg+xml")).toBe(true);
    });

    test("preserves order and skips entries that resolve to no image", () => {
        const badges = parseYtBadges([
            roleBadge("MODERATOR", "Moderátor"),
            // No customThumbnail and an unknown icon → dropped.
            { liveChatAuthorBadgeRenderer: { tooltip: "?", accessibility: acc("?") } },
            memberBadge("Člen"),
        ]);
        expect(badges?.map((b) => b.type)).toEqual(["moderator", "member"]);
    });

    test("returns undefined for empty / absent input", () => {
        expect(parseYtBadges([])).toBeUndefined();
        expect(parseYtBadges(undefined)).toBeUndefined();
    });
});

// --- Pure parsing: badgesByItemId -------------------------------------------

describe("badgesByItemId", () => {
    test("indexes authorBadges by chat item id and skips badge-less messages", () => {
        const actions: Action[] = [
            textAction("m1", [roleBadge("MODERATOR", "Moderátor")]),
            textAction("m2"), // no badges
            {
                addChatItemAction: {
                    item: {
                        liveChatPaidMessageRenderer: {
                            ...textAction("m3", [memberBadge()]).addChatItemAction
                                ?.item?.liveChatTextMessageRenderer,
                            purchaseAmountText: { simpleText: "1.00" },
                            headerBackgroundColor: 0,
                            headerTextColor: 0,
                            bodyBackgroundColor: 0,
                            bodyTextColor: 0,
                            authorNameTextColor: 0,
                        } as never,
                    },
                    clientId: "c-m3",
                },
            } as Action,
            { markChatItemAsDeletedAction: { targetItemId: "m1" } } as unknown as Action,
        ];
        const map = badgesByItemId(actions);
        expect(map.get("m1")?.[0].liveChatAuthorBadgeRenderer.icon?.iconType).toBe(
            "MODERATOR",
        );
        expect(map.has("m2")).toBe(false);
        expect(map.get("m3")?.[0].liveChatAuthorBadgeRenderer.tooltip).toBe(
            "Nový člen",
        );
    });
});

// --- End-to-end: badges ride the wire ---------------------------------------

describe("YouTube provider badge wiring", () => {
    const RESPONSE = (action: Action | null) => ({
        continuationContents: {
            liveChatContinuation: {
                actions: action ? [action] : [],
                continuations: [
                    { timedContinuationData: { timeoutMs: 1000, continuation: "tok" } },
                ],
            },
        },
    });

    let fetchCalls = 0;

    beforeEach(() => {
        fetchCalls = 0;
        // Stub the axios-based live-page scrape so we only exercise the poll.
        mock.module("youtube-chat-next/dist/requests", () => ({
            fetchLivePage: async () => ({
                apiKey: "TESTKEY",
                clientVersion: "1.0",
                continuation: "",
            }),
            fetchChat: async () => {
                throw new Error("unused");
            },
        }));
        // Poll responses: first is the (skipped) history page, second carries
        // a fresh message with badges.
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            const body =
                fetchCalls === 1
                    ? RESPONSE(null)
                    : RESPONSE(textAction("m2", [roleBadge("MODERATOR", "Moderátor"), memberBadge("Člen")]));
            return Response.json(body) as unknown as Response;
        }) as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        mock.module("youtube-chat-next/dist/requests", () =>
            import("youtube-chat-next/dist/requests"),
        );
    });

    function lastMessage(frames: string[]): ChatLive | undefined {
        const chatFrame = frames
            .map((f) => JSON.parse(f))
            .find((f) => f.event === "youtube.chat" && f.data?.message);
        return chatFrame?.data?.message as ChatLive | undefined;
    }

    test("a poll message carries member + moderator badges on the wire", async () => {
        const { YoutubeChatProvider } = await import(
            "../server/modules/chat/providers/youtube"
        );
        const frames: string[] = [];
        const provider = new YoutubeChatProvider("channel", (msg) =>
            frames.push(msg),
        );
        provider.start();

        // Wait for the second poll (message is skipped on the first).
        for (let i = 0; i < 200 && !lastMessage(frames); i++) await sleep(20);

        const msg = lastMessage(frames);
        provider.stop();

        expect(msg?.id).toBe("m2");
        expect(msg?.badges?.map((b) => b.type)).toEqual(["moderator", "member"]);
        expect(msg?.badges?.[0].url?.startsWith("data:image/svg+xml")).toBe(true);
        expect(msg?.badges?.[1].url).toBe("https://yt3.ggpht.com/member=s16");
    });
});
