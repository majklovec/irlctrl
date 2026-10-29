/**
 * chat widget — local wire/state types. The module is self-contained:
 * it declares the shapes it exchanges over the dashboard websocket and the
 * hub/manager contract it implements. The core reaches this module only
 * structurally (the registry validates the shape), so no type crosses a
 * module boundary.
 *
 * One `chat` widget merges the messages of every platform whose channel is
 * filled in its config (YouTube, Twitch, TikTok, Kick). The hub (backend.ts)
 * keeps one provider per platform+channel; each provider pushes on its
 * platform wire event (`youtube.chat`, `twitch.chat`, `tiktok.chat`,
 * `kick.chat`) so the dashboard websocket carries the frames unchanged.
 */

/** One chat message (platform message id used for deduplication). */
export interface ChatLive {
    id: string | number;
    username?: string;
    /** The sender's platform color (hex), for username display. */
    color?: string;
    text?: string;
    /** The message's classification; `banned` marks a message removed by the
     * platform's moderation (shown struck-through or hidden per widget config). */
    type?: string;
    /** Message time (epoch ms) — where the platform provides it. */
    ts?: number;
}

/** `ChatLive.type` value marking a message removed by the platform's
 * moderation. The frontend renders these struck-through or hidden per the
 * widget's `bannedMessages` config, and stops any in-flight TTS for them. */
export const CHAT_BANNED_TYPE = "banned" as const;

/** The platform a live fragment / spec key refers to. */
export type ChatPlatform = "youtube" | "twitch" | "tiktok" | "kick";

/** A hub spec: `<platform>:<channel>` (channel lowercased, no `@`). */
export type ChatSpec = `${ChatPlatform}:${string}`;

/** One channel's snapshot entry: connection state + rolling messages. */
export interface ChannelLive {
    /** the provider's socket/poller for this channel was open */
    connected?: boolean;
    /** most recent messages, newest first */
    chat?: ChatLive[];
}

/** Channels to keep attached (spec keys). */
export type ChannelSpecs = Set<string>;

/** Deliver a serialized event frame to subscribers. */
export type PublishFn = (msg: string) => void;

/** Serialize an event frame for the module websockets. */
export const eventFrame = (event: string, data: unknown): string =>
    JSON.stringify({ type: "event", event, data });

/** A config parameter: a bare string (free text) or a `{name, type:"select",
 * options}` fixed-choice field rendered as a dropdown. */
export type WidgetConfigField =
    | string
    | { name: string; type: "select"; options: readonly string[] };
