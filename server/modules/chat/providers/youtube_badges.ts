// Map YouTube live chat's raw `authorBadges` renderers to wire `ChatBadge`
// entries, plus the small helper that pulls those renderers out of a
// `get_live_chat` response.
//
// YouTube's raw `get_live_chat` action carries, per message, an
// `authorBadges` array of `liveChatAuthorBadgeRenderer`s in two flavors:
//
//   - *Channel membership* badges ship a `customThumbnail` image (the
//     channel's own tier art, e.g. "Nový člen" / "Member (6 months)") —
//     rendered directly as an image.
//   - *Role* badges (owner, moderator, verified channel, host) are
//     icon-only: the API sends just an `iconType` + `tooltip`, no image url.
//     YouTube's web client paints them from CSS/SVG, so we ship matching
//     self-contained inline-SVG data-URIs (the same approach as
//     `kick_badges.ts`) so the feed's image-only badge renderer shows them.
//
// The library's `parseChatData` collapses these into one `author.badge`
// (membership) + booleans, so we read the raw renderers instead to keep every
// badge and its order.

import type { ChatBadge } from "../types";
import type {
    Action,
    AuthorBadge,
} from "youtube-chat-next/dist/types/yt-response";

const utf8Svg = (markup: string): string =>
    `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;

// Role badge artwork, keyed by the API `iconType`.
const ROLE_BADGES: Record<string, string> = {
    // Streamer / channel owner — gold crown.
    OWNER: utf8Svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><path fill="#ffca28" d="M1.6 11.6 1.1 4.9l3.5 2.1L8 3l3.4 4 3.5-2.1-.5 6.7Z"/><rect x="1.5" y="12.4" width="13" height="1.7" fill="#ffca28"/></svg>',
    ),
    // Moderator — teal shield with a white check.
    MODERATOR: utf8Svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><path fill="#00c9a7" d="M8 1.2 2.6 3.3v3.9c0 3.4 2.3 5.9 5.4 6.9 3.1-1 5.4-3.5 5.4-6.9V3.3L8 1.2Zm0 1.5 4 1.6v2.9c0 2.7-1.7 4.7-4 5.6-2.3-.9-4-2.9-4-5.6V4.3l4-1.6Z"/><path fill="#fff" d="M7.3 10.5 5.2 8.4l.9-.9.6.6 2.9-2.9.9.9-3.5 3.9Z"/></svg>',
    ),
    // Verified channel — blue seal with a white check.
    VERIFIED_CHANNEL: utf8Svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="#1a73e8"/><path fill="#fff" d="m7.3 10.6-2.5-2.5.9-.9 1.2 1.2 3.4-3.4.9.9-4.3 4.3Z"/></svg>',
    ),
    // Host (game / stream host) — purple star.
    HOST: utf8Svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><path fill="#aa5cff" d="m8 1.5 1.9 4.1 4.3.4-3.2 2.8 1 4.2L8 11l-4 2 1-4.2L1.8 6l4.3-.4L8 1.5Z"/></svg>',
    ),
};

/** Pick the smallest thumbnail (badges render ~16 px); fall back to the first. */
function pickThumbnail(
    thumbnails: { url: string; width?: number }[] | undefined,
): string | undefined {
    if (!thumbnails?.length) return undefined;
    return [...thumbnails]
        .sort((a, b) => (a.width ?? Infinity) - (b.width ?? Infinity))[0].url;
}

/** Map one raw `authorBadges` array to wire badges in order. Membership
 * badges use their own art, role badges use the inline SVG above; entries
 * that resolve to no image are skipped, and the list is left out entirely
 * when nothing parses. */
export function parseYtBadges(
    badges: AuthorBadge[] | undefined,
): ChatBadge[] | undefined {
    const out: ChatBadge[] = [];
    for (const entry of badges ?? []) {
        const badge = entry.liveChatAuthorBadgeRenderer;
        const text = badge.tooltip || undefined;
        const image = pickThumbnail(badge.customThumbnail?.thumbnails);
        if (image) {
            const item: ChatBadge = { type: "member", text, url: image };
            out.push(item);
            continue;
        }
        const iconType = badge.icon?.iconType;
        const svg = iconType ? ROLE_BADGES[iconType] : undefined;
        if (svg) {
            const item: ChatBadge = {
                type: (iconType ?? "").toLowerCase(),
                text,
                url: svg,
            };
            out.push(item);
        }
    }
    return out.length ? out : undefined;
}

/** Index the raw `authorBadges` of every `addChatItemAction` message by its
 * chat item id, so the poll loop can attach them to the library-parsed items
 * (the library folds badges to one image + booleans, losing the rest). */
export function badgesByItemId(actions: Action[]): Map<string, AuthorBadge[]> {
    const map = new Map<string, AuthorBadge[]>();
    for (const action of actions) {
        const item = action.addChatItemAction?.item;
        if (!item) continue;
        const renderer =
            item.liveChatTextMessageRenderer ??
            item.liveChatPaidMessageRenderer ??
            item.liveChatMembershipItemRenderer ??
            item.liveChatPaidStickerRenderer;
        const id = renderer?.id;
        const badges = renderer?.authorBadges;
        if (id && badges?.length) map.set(id, badges);
    }
    return map;
}
