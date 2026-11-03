/**
 * Kick chat provider — Kick does not expose a direct chat websocket; chat
 * rides Pusher. Each channel is resolved to its chatroom id through
 * kick.com's public REST API, joined on Pusher's public app, and the
 * unauthenticated `chatrooms.<id>.v2` channel is subscribed; each
 * `App\Events\ChatMessageEvent` payload becomes a `kick.chat` push. The
 * subscribe handshake is capped by a timeout (a stalled handshake would
 * otherwise hang the connection forever). When the REST response says the
 * channel is offline (`livestream.is_live` is not true) the provider reports
 * `disconnected` and re-polls until the stream goes live.
 */
import type { ChatBadge, ChatLive, PublishFn } from "../types";
import { kickRoleBadgeUrl } from "./kick_badges";
import { ChatProvider } from "./base";

/** Channel slug -> chatroom id lookup. */
const KICK_CHANNEL_API = "https://kick.com/api/v2/channels";
const RESOLVE_TIMEOUT_MS = 10_000;
/** Give up on the subscribe handshake when it does not complete in time. */
const SUBSCRIBE_TIMEOUT_MS = 10_000;
/** Rejoin the chatroom after this long without a single chat message. Pusher's
 * `pusher:ping` keeps a half-open socket alive, so a silently-lost chatroom
 * subscription would otherwise freeze forever (the feed shows the last
 * messages and a "connected" state, updating only on a manual reconnect).
 * Bounding the no-message window turns that into an automatic, transparent
 * rejoin — the same reset that switching channels performs by hand. The timer
 * is re-armed on every chat message, so it only fires after a full window of
 * silence. Overridable (e.g. for tests) via the environment. */
const KICK_CHAT_STALE_MS =
    Number(process.env.SRTLA_KICK_CHAT_STALE_MS) || 3 * 60_000;

/** Kick's public Pusher chat app (protocol 7, anonymous join). The app key
 * rotates over time: a stale key ends up on no cluster and Pusher answers
 * `pusher:error` code 4001. Default to a known-good `{ key, cluster }` and
 * optionally ask a resolver for a fresh one each connect (see
 * `resolvePusherKey`); on a 4001 the current key is marked stale and the
 * resolver is asked again on the next connect. */
const PUSHER_DEFAULT = { key: "34bf7a0ff419a2a775b9", cluster: "us2" };
const PUSHER_KEY_RE = /^[a-f0-9]{16,40}$/;
const PUSHER_CLUSTER_RE = /^[a-z0-9-]{2,12}$/;
const PUSHER_RESOLVER_URL = process.env.SRTLA_KICK_PUSHER_REALTIME_URL ?? "";

const pusherUrl = (k: { key: string; cluster: string }): string =>
    `wss://ws-${k.cluster}.pusher.com/app/${k.key}?protocol=7&client=js&version=8.3.0&flash=false`;

/** Optional key resolver: `GET <url>[?stale=<oldKey>]` -> `{key, cluster}`,
 * both validated. Returns null when unconfigured, on error/timeout, or when
 * the payload is invalid — the caller then keeps its current key. */
async function resolvePusherKey(
    stale = "",
): Promise<{ key: string; cluster: string } | null> {
    if (!PUSHER_RESOLVER_URL) return null;
    const qs = stale ? `?stale=${encodeURIComponent(stale)}` : "";
    const res = await fetch(PUSHER_RESOLVER_URL + qs, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { key?: string; cluster?: string };
    if (
        data &&
        PUSHER_KEY_RE.test(String(data.key)) &&
        PUSHER_CLUSTER_RE.test(String(data.cluster))
    )
        return { key: String(data.key), cluster: String(data.cluster) };
    return null;
}

export class KickChatProvider extends ChatProvider {
    #chatroom: number | null = null;
    /** Channel-specific subscriber badge artwork, resolved from the same
     * `kick.com/api/v2/channels/<slug>` response that supplies the chatroom id
     * (Kick's chat wire only carries the month `count`, never the image). */
    #subscriberTiers: { months: number; url: string }[] = [];
    #ws: WebSocket | null = null;
    #subscribed = false;
    #subscribeTimer: ReturnType<typeof setTimeout> | null = null;
    #staleTimer: ReturnType<typeof setTimeout> | null = null;
    #pusher: { key: string; cluster: string } = PUSHER_DEFAULT;
    #staleKey = "";

    constructor(channel: string, publish: PublishFn) {
        super("kick", channel, publish);
    }

    protected connect(): void {
        // Refresh the Pusher key before each connect (passing the stale key so
        // the resolver can avoid handing back the same one), then resolve the
        // channel and join Pusher.
        void resolvePusherKey(this.#staleKey)
            .then((fresh) => {
                this.#staleKey = "";
                if (fresh) this.#pusher = fresh;
                return resolveChatroom(this.channel);
            })
            .catch((err: unknown) => {
                this.#staleKey = "";
                throw err;
            })
            .then(({ id, isLive, subscriberTiers }) => {
                if (this.stopped) return;
                if (!isLive) {
                    // Channel is offline: report disconnected and re-poll
                    // (the resolve call doubles as the live check).
                    this.log("connect", "channel offline (livestream.is_live)");
                    this.setConnected(false);
                    this.scheduleReconnect();
                    return;
                }
                this.#chatroom = id;
                this.#subscriberTiers = subscriberTiers;
                const ws = new WebSocket(pusherUrl(this.#pusher));
                this.#ws = ws;
                ws.addEventListener("message", (ev: MessageEvent) =>
                    this.#onPusherMessage(ev),
                );
                ws.addEventListener("close", () => this.#onPusherClose());
                ws.addEventListener("error", () => ws.close());
                this.#armSubscribeTimer();
            })
            .catch((err: unknown) => {
                this.log(
                    "connect failed",
                    err instanceof Error ? err.message : String(err),
                );
                this.scheduleReconnect();
            });
    }

    protected teardown(): void {
        this.#disarmSubscribeTimer();
        this.#disarmStaleTimer();
        this.#ws?.close();
        this.#ws = null;
    }

    #onPusherMessage(ev: MessageEvent): void {
        if (!this.#chatroom || !this.#ws) return;
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        let msg: { event?: string; data?: unknown };
        try {
            msg = JSON.parse(raw) as { event?: string; data?: unknown };
        } catch {
            return;
        }
        switch (msg.event) {
            case "pusher:connection_established":
                this.#ws.send(
                    JSON.stringify({
                        event: "pusher:subscribe",
                        data: {
                            auth: "",
                            channel: `chatrooms.${this.#chatroom}.v2`,
                        },
                    }),
                );
                break;
            case "pusher:ping":
                this.#ws.send(
                    JSON.stringify({ event: "pusher:pong", data: {} }),
                );
                break;
            case "pusher:error": {
                const data = msg.data as
                    | { code?: number; message?: string }
                    | undefined;
                // 4001: the app key is not on this cluster — it has rotated.
                // Mark it stale so the resolver is asked for a fresh key on
                // the next connect, then drop the connection.
                if (data?.code === 4001) {
                    this.#staleKey = this.#pusher.key;
                    this.log(
                        "pusher",
                        `key ${this.#pusher.key.slice(0, 6)}… stale (${data.message})`,
                    );
                    this.#ws?.close();
                    return;
                }
                this.log("pusher error", JSON.stringify(data));
                this.#ws?.close();
                return;
            }
            case "pusher_internal:subscription_succeeded":
                this.#disarmSubscribeTimer();
                this.#subscribed = true;
                // Watch for a silently-lost subscription (see KICK_CHAT_STALE_MS).
                this.#armStaleTimer();
                // Re-deliver the rolling buffer so a fresh viewer can top up.
                this.setConnected(true);
                break;
            case "App\\Events\\ChatMessageEvent": {
                let payload: unknown;
                try {
                    payload =
                        typeof msg.data === "string"
                            ? JSON.parse(msg.data)
                            : msg.data;
                } catch {
                    return;
                }
                const line = asChatMessage(payload, this.#subscriberTiers);
                if (!line) return;
                this.deliver(line);
                // Any chat traffic proves the subscription is alive.
                this.#armStaleTimer();
                break;
            }
            case "App\\Events\\UserBannedEvent": {
                let payload: unknown;
                try {
                    payload =
                        typeof msg.data === "string"
                            ? JSON.parse(msg.data)
                            : msg.data;
                } catch {
                    return;
                }
                this.#onUserBanned(payload);
                break;
            }
            default:
                break;
        }
    }

    /**
     * `App\Events\UserBannedEvent` — a user was banned in this chat (removed
     * by a mod or the broadcaster), so every message of theirs becomes banned.
     * The payload's top-level `username` is who was banned (Kick shares one
     * canonical username between chat senders and ban events).
     */
    #onUserBanned(payload: unknown): void {
        if (!payload || typeof payload !== "object") return;
        const username = (payload as Record<string, unknown>).username;
        if (typeof username === "string") this.banUser(username);
    }

    #onPusherClose(): void {
        this.#disarmSubscribeTimer();
        this.#disarmStaleTimer();
        if (this.#subscribed) {
            this.#subscribed = false;
            this.setConnected(false);
        }
        this.scheduleReconnect();
    }

    #armSubscribeTimer(): void {
        this.#disarmSubscribeTimer();
        this.#subscribeTimer = setTimeout(
            () => this.#ws?.close(),
            SUBSCRIBE_TIMEOUT_MS,
        );
    }

    #disarmSubscribeTimer(): void {
        if (this.#subscribeTimer) {
            clearTimeout(this.#subscribeTimer);
            this.#subscribeTimer = null;
        }
    }

    /** Arm the staleness watchdog: if no chat message arrives within
     * `KICK_CHAT_STALE_MS`, drop the socket so it reconnects (rejoin). The
     * close handler then marks the channel disconnected and schedules the
     * retry — the self-healing path a silent subscription death would not
     * take on its own. */
    #armStaleTimer(): void {
        this.#disarmStaleTimer();
        this.#staleTimer = setTimeout(() => {
            this.#staleTimer = null;
            this.log(
                "stale",
                `no chat for ${KICK_CHAT_STALE_MS / 1000}s — rejoining`,
            );
            this.#ws?.close();
        }, KICK_CHAT_STALE_MS);
    }

    #disarmStaleTimer(): void {
        if (this.#staleTimer) {
            clearTimeout(this.#staleTimer);
            this.#staleTimer = null;
        }
    }
}

/** Resolve a channel slug to the chatroom id hosting its chat, plus
 * whether the channel is currently live (`livestream.is_live` in the same
 * response) and the channel's subscriber badge artwork (per-month image urls).
 * Subscriber art lives only here — the chat wire carries just the month count
 * — so it is resolved once per connect from this same endpoint. */
async function resolveChatroom(slug: string): Promise<{
    id: number;
    isLive: boolean;
    subscriberTiers: { months: number; url: string }[];
}> {
    const res = await fetch(`${KICK_CHANNEL_API}/${encodeURIComponent(slug)}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`kick channel HTTP ${res.status}`);
    const data = (await res.json()) as {
        chatroom?: { id?: number };
        livestream?: { is_live?: boolean };
        subscriber_badges?: {
            months?: number;
            badge_image?: { src?: string };
        }[];
    };
    const id = data.chatroom?.id;
    if (id === undefined || id === null)
        throw new Error("no chatroom id in response");
    return {
        id,
        isLive: data.livestream?.is_live === true,
        subscriberTiers: parseSubscriberTiers(data.subscriber_badges),
    };
}

/** Map the channel's `subscriber_badges` (per-month artwork) to a month
 * -> image-url table, ascending. Entries without a usable image or a sane
 * month count are dropped. */
function parseSubscriberTiers(
    raw:
        |
            { months?: number; badge_image?: { src?: string } }[]
        | undefined,
): { months: number; url: string }[] {
    if (!Array.isArray(raw)) return [];
    const tiers = new Map<number, string>();
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const months = entry.months;
        const url = entry.badge_image?.src;
        if (
            typeof months !== "number" ||
            !Number.isInteger(months) ||
            months < 1
        )
            continue;
        if (typeof url !== "string" || !/^https?:\/\//.test(url)) continue;
        if (!tiers.has(months)) tiers.set(months, url);
    }
    return [...tiers.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([months, url]) => ({ months, url }));
}

function asChatMessage(
    raw: unknown,
    subscriberTiers: { months: number; url: string }[] = [],
): ChatLive | null {
    if (!raw || typeof raw !== "object") return null;
    const msg = raw as Record<string, unknown>;
    if (msg.id === undefined || msg.id === null) return null;

    const sender = (msg.sender as Record<string, unknown> | undefined) ?? {};
    const username =
        typeof sender.username === "string" ? sender.username : undefined;
    const identity =
        (sender.identity as Record<string, unknown> | undefined) ?? {};
    const color =
        typeof identity.color === "string" &&
        /^#[0-9a-fA-F]{3,8}$/.test(identity.color)
            ? identity.color
            : undefined;
    const badges = parseIdentityBadges(identity, subscriberTiers);

    let text =
        typeof msg.content === "string" && msg.content !== ""
            ? msg.content
            : typeof msg.message === "string" && msg.message !== ""
              ? msg.message
              : undefined;

    const metadata =
        (msg.metadata as Record<string, unknown> | undefined) ?? {};
    const originalSender =
        (metadata.original_sender as Record<string, unknown> | undefined) ?? {};
    const replyUsername =
        typeof originalSender.username === "string"
            ? originalSender.username
            : undefined;
    // replies get an @mention of the replied-to user prepended to the text
    if (text && replyUsername) text = `@${replyUsername} ${text}`;

    if (username === undefined && text === undefined) return null;

    const out: ChatLive = {
        id: typeof msg.id === "number" ? msg.id : String(msg.id),
    };
    if (username) out.username = username;
    if (color) out.color = color;
    if (badges.length) out.badges = badges;
    if (text) out.text = text;
    if (typeof msg.created_at === "string") {
        const ts = Date.parse(msg.created_at);
        if (Number.isFinite(ts)) out.ts = ts;
    }
    return out;
}

const V2_BADGE_IMAGE_RE =
    /^https:\/\/ext\.cdn\.kick\.com\/chat\/badges\/[a-zA-Z0-9_-]{1,200}\.(?:png|webp)(\?width=\d+,format=webp,quality=\d{1,3})?$/;

/** Map a Kick `sender.identity` object to the wire `ChatBadge` shape. Kick
 * sends two arrays per sender:
 *   - `badges_v2`: the current system, where every badge carries its own
 *     `image_url` (global/channel/user custom badges, the user's level) —
 *     rendered directly as an image. A v2 entry that names a role badge
 *     (moderator, vip, verified, …) but ships no image falls back to that
 *     role's inline-SVG data-URI.
 *   - `badges`: the legacy array, where a `subscriber` entry is just
 *     `{ type, count }` with no image; the channel-specific artwork is looked
 *     up from `subscriberTiers` (fetched from the channel API) by month. Other
 *     role badges (moderator, vip, verified, founder, og, sub_gifter, staff,
 *     broadcaster, sidekick) also ship no image and are mapped to their
 *     inline-SVG data-URI.
 * Only badges that resolve to a real image (CDN url or inline-SVG data-URI)
 * are emitted (image-only, matching Kick's rendered chat). */
function parseIdentityBadges(
    identity: Record<string, unknown>,
    subscriberTiers: { months: number; url: string }[],
): ChatBadge[] {
    const out: ChatBadge[] = [];
    const seen = new Set<string>();
    const push = (badge: ChatBadge) => {
        // Dedup by `type` (fall back to url/text) so a role that appears in
        // both the v2 and legacy arrays is shown once; the first (v2) wins,
        // preferring real CDN artwork over the inline-SVG fallback.
        const key = badge.type ?? badge.url ?? badge.text ?? "";
        if (seen.has(key)) return;
        seen.add(key);
        out.push(badge);
    };

    // 1) `badges_v2` — each entry supplies its artwork via `image_url`.
    const v2 = Array.isArray(identity.badges_v2) ? identity.badges_v2 : [];
    const v2Badges = v2
        .map((item) => {
            if (!item || typeof item !== "object") return null;
            const b = item as Record<string, unknown>;
            const name =
                typeof b.name === "string" && b.name ? b.name : undefined;
            // Prefer the CDN artwork; role badges that ship no image fall
            // back to their inline-SVG data-URI.
            const cdnUrl =
                typeof b.image_url === "string" &&
                V2_BADGE_IMAGE_RE.test(b.image_url)
                    ? b.image_url
                    : undefined;
            const url = cdnUrl ?? (name ? kickRoleBadgeUrl(name) : undefined);
            // The level marker renders even when not explicitly selected;
            // all other cosmetics only when the user has chosen to display
            // them.
            if (name !== "level") {
                const selected = b.selected === true || b.active === true;
                if (!selected) return null;
            }
            if (!name || !url) return null;
            const level =
                typeof b.metadata === "object" && b.metadata
                    ? (b.metadata as Record<string, unknown>).level
                    : undefined;
            const text =
                name === "level" &&
                typeof level === "number" &&
                Number.isInteger(level)
                    ? `Level ${level}`
                    : name;
            const badge: ChatBadge = { type: name, text, url };
            if (name === "level" && typeof level === "number")
                badge.count = level;
            return badge;
        })
        .filter((b): b is ChatBadge => b !== null);
    for (const badge of v2Badges) push(badge);

    // 2) legacy `badges` — resolve the subscriber artwork from the channel.
    const legacy = Array.isArray(identity.badges) ? identity.badges : [];
    for (const item of legacy) {
        if (!item || typeof item !== "object") continue;
        const b = item as Record<string, unknown>;
        const type = typeof b.type === "string" ? b.type : undefined;
        const text =
            typeof b.text === "string" && b.text ? b.text : undefined;
        const count =
            typeof b.count === "number" && Number.isFinite(b.count)
                ? b.count
                : undefined;
        if (type === "subscriber") {
            const url = resolveSubscriberUrl(subscriberTiers, count);
            if (!url) continue;
            const badge: ChatBadge = { type: "subscriber", url };
            if (text) badge.text = text;
            if (count !== undefined) badge.count = count;
            push(badge);
            continue;
        }
        // Other legacy roles (moderator, vip, verified, founder, og,
        // sub_gifter, staff, broadcaster, sidekick) ship no image; map them to
        // their inline-SVG data-URI, falling back to an explicit url if the
        // payload happens to provide one.
        const url =
            kickRoleBadgeUrl(type) ??
            (typeof b.url === "string" && /^https?:\/\//.test(b.url)
                ? b.url
                : undefined);
        if (url) {
            const badge: ChatBadge = { url };
            if (type) badge.type = type;
            if (text) badge.text = text;
            if (count !== undefined) badge.count = count;
            push(badge);
        }
    }
    return out;
}

/** Pick the channel subscriber artwork for a given month count: the exact
 * month when available, else the highest tier at or below it (Kick's
 * milestone art, e.g. 42 months -> the 36-month badge). */
function resolveSubscriberUrl(
    tiers: { months: number; url: string }[],
    count?: number,
): string | undefined {
    if (!count || count < 1) return undefined;
    const exact = tiers.find((t) => t.months === count);
    if (exact) return exact.url;
    const milestone = tiers.filter((t) => t.months <= count).at(-1);
    return milestone?.url;
}
