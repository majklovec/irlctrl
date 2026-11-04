// Mapping of Twitch's IRCv3 `badges` tag to wire `ChatBadge` entries.
//
// Twitch sends sender badges as a comma-separated `set_id/version` list in the
// `badges` tag of every PRIVMSG (e.g. `moderator/1,turbo/1,subscriber/6`).
// The tag carries no artwork. The CDN url is
// `https://static-cdn.jtvnw.net/badges/v1/<guid>/<version>`, where `<guid>` is
// per-badge - Twitch moved off the old `modges/1/directory/<id>/<version>`
// path (a hard 404 now), so the `(set_id, version) -> guid` mapping must come
// from Twitch's own catalog: `TWITCH_BADGE_ART` (generated from Helix
// `chat/badges/global`, the same source Chatterino ships).
//
// A `(set_id, version)` that isn't in the catalog resolves to no image, so it
// is skipped entirely - the feed only renders `<img>` for badges that have a
// real url, so unknown badges render as nothing instead of a broken image.
// That intentionally drops dynamic-quantity badges (bits/5000, sub-gifter/250,
// moments/10, ...) and channel-specific subscriber tiers
// (`subscriber_badge_<n>`), which have no pre-generated global art.

import type { ChatBadge } from "../types";
import { TWITCH_BADGE_ART } from "./twitch_badge_art";

const BADGE_CDN = "https://static-cdn.jtvnw.net/badges/v1";

/** Build the badge CDN url for one `(set_id, version)` pair, looked up in the
 * catalog. Returns `undefined` when the pair has no known art. */
export function twitchBadgeUrl(
    setId: string,
    version: string,
): { url: string; title: string } | undefined {
    const art = TWITCH_BADGE_ART[setId]?.[version];
    if (!art) return undefined;
    const [guid, title] = art;
    return { url: `${BADGE_CDN}/${guid}/${version}`, title };
}

/** Parse the `badges` tag (`moderator/1,turbo/1,...`) to wire badges in the
 * order Twitch lists them. The version is the final `/`-separated segment, so
 * `set_id`s that themselves contain a slash are handled; pairs with no known
 * art are skipped, and the list is left out entirely when nothing resolves. */
export function parseTwitchBadges(value: string): ChatBadge[] | undefined {
    const out: ChatBadge[] = [];
    for (const pair of value.split(",")) {
        const s = pair.trim();
        const slash = s.lastIndexOf("/");
        if (slash === -1) continue;
        const resolved = twitchBadgeUrl(s.slice(0, slash), s.slice(slash + 1));
        if (!resolved) continue;
        out.push({
            type: s.slice(0, slash),
            text: resolved.title,
            url: resolved.url,
        });
    }
    return out.length ? out : undefined;
}
