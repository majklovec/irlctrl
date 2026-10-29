/*
 * chat widget — config parameters and feed options, shared by the backend
 * hub (spec computation, validation) and the frontend (editor form, merged
 * feed). Pure: this file must stay free of any package import (the frontend
 * bundle imports it; the providers in `providers/` carry the npm deps and
 * are backend-only).
 */
/** TTS speech-rate options (the `ttsRate` select). eSpeak voices run fast,
 * so the lower values are clearer; `1.0` is normal Web Speech speed. */
export const CHAT_TTS_RATE_OPTIONS = ["0.75", "0.85", "0.95", "1.0"] as const;
/** chat widget's configurable parameters (single source for the server
 * validation and the frontend editor): one channel per platform, then the
 * shared feed options, then the Czech TTS options. */
export const CHAT_CONFIG_FIELDS = [
    "youtube",
    "twitch",
    "tiktok",
    "kick",
    "history",
    { name: "order", type: "select", options: ["top", "bottom"] },
    { name: "bannedMessages", type: "select", options: ["strike", "hide"] },
    { name: "timestamps", type: "select", options: ["off", "on"] },
    {
        name: "ttsEnabled",
        type: "select",
        options: ["off", "on"],
    },
    // Empty static options: the voice list is browser-discovered at runtime
    // (the module's `configSelectOptions` fills it in, UI language first).
    { name: "ttsVoice", type: "select", options: [] },
    { name: "ttsRate", type: "select", options: CHAT_TTS_RATE_OPTIONS },
    "ignoredWords",
    "ignoredUsernames",
] as const;
export const CHAT_PLATFORMS = ["youtube", "twitch", "tiktok", "kick"] as const;
/** Default visible history size — matches the backend rolling-history cap. */
export const DEFAULT_HISTORY_LINES = 500;
/** Where new messages enter the feed: "top" (the default, newest first) or
 * "bottom" (oldest first, new lines arrive at the bottom). */
export type ChatOrder = "top" | "bottom";

/**
 * A widget's visible-history size, validated from its config. Non-numeric,
 * non-positive or absurd values fall back to the default rather than crashing
 * the frontend (the value renders as-is there).
 */
export function historyLengthFromConfig(
    config: Record<string, string> | undefined,
): number {
    const value = (config?.history ?? "").trim().replace(/^\D+|\s+$/g, "");
    if (!value) return DEFAULT_HISTORY_LINES;
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 10_000)
        return DEFAULT_HISTORY_LINES;
    return n;
}

/**
 * A widget's new-message placement, validated from its config. Anything that
 * is not "bottom" falls back to "top" (the historic default, newest first).
 */
export function chatOrderFromConfig(
    config: Record<string, string> | undefined,
): ChatOrder {
    const value = (config?.order ?? "").trim().toLowerCase();
    return value === "bottom" ? "bottom" : "top";
}

/** How banned (moderated) messages present in the feed. */
export type ChatBannedMode = "strike" | "hide";

/**
 * A widget's banned-message presentation, validated from its config. Anything
 * that is not "hide" falls back to "strike" (the default: keep the line in
 * place but crossed out, so the removal is visible).
 */
export function bannedMessagesFromConfig(
    config: Record<string, string> | undefined,
): ChatBannedMode {
    const value = (config?.bannedMessages ?? "").trim().toLowerCase();
    return value === "hide" ? "hide" : "strike";
}

/**
 * Whether a widget shows each message's arrival time next to its line.
 * Anything that is not "on" falls back to "off" (the default: no timestamps).
 */
export function chatTimestampsFromConfig(
    config: Record<string, string> | undefined,
): boolean {
    return (config?.timestamps ?? "").trim().toLowerCase() === "on";
}

/** Normalize one platform channel value (lowercased, trimmed; "" when empty). */
const channelPart = (value: string | undefined): string =>
    (value ?? "").trim().toLowerCase();

/** The channel for one platform from a widget's config ("" when the platform
 * channel is not filled). */
export function platformChannel(
    platform: (typeof CHAT_PLATFORMS)[number],
    config: Record<string, string> | undefined,
): string {
    return channelPart(config?.[platform]);
}

/** The hub specs from one widget's config: one `<platform>:<channel>` per
 * filled platform channel (empty platforms produce no spec, so the widget can
 * merge with other widgets that fill the same channel). */
export function chatSpecsFromConfig(
    config: Record<string, string> | undefined,
): (string | null)[] {
    return CHAT_PLATFORMS.map((platform) => {
        const name = platformChannel(platform, config);
        return name ? `${platform}:${name}` : null;
    });
}

// ── Czech TTS (text-to-speech) config parsing and filtering ─────────────────
// Pure, like the rest of this file: the frontend calls these on every frame;
// no package imports, no DOM access.

/** One parsed TTS setting set, ready for the filter and the speech queue. */
export interface ChatTtsConfig {
    /** Whether TTS is on at all (`ttsEnabled` select; off = never speak). */
    enabled: boolean;
    /** A `voice.name` substring ("" = the module's preferred default voice). */
    voice: string;
    /** Speech rate (0.5–1.5); `1` when the config value is unusable. */
    rate: number;
    /** Lowercased comma-separated words — a message containing one is muted. */
    words: string[];
    /** Lowercased comma-separated usernames — their messages are muted. */
    usernames: string[];
}

/** Split a comma-separated config value into trimmed, lowercased parts. */
const csv = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part !== "");

/**
 * A widget's TTS settings, validated from its config. Non-numeric rates fall
 * back to `1`; empty fields produce empty lists (nothing ignored).
 */
export function chatTtsConfig(
    config: Record<string, string> | undefined,
): ChatTtsConfig {
    const rawRate = parseFloat((config?.ttsRate ?? "").trim());
    return {
        enabled: (config?.ttsEnabled ?? "off").trim() === "on",
        voice: (config?.ttsVoice ?? "").trim(),
        rate: Number.isFinite(rawRate) && rawRate >= 0.5 && rawRate <= 1.5 ? rawRate : 1,
        words: csv(config?.ignoredWords),
        usernames: csv(config?.ignoredUsernames),
    };
}

/** A platform message's text, trimmed ("" when absent). */
const messageText = (message: { text?: string }): string =>
    (message?.text ?? "").trim();

/**
 * Decide whether a chat message should be read out loud. The checks run in a
 * fixed, cheap-first order:
 *   0. TTS not enabled
 *   1. empty text
 *   2. a command (starts with `!`)
 *   3. a bare URL
 *   4. too long (> 200 chars — keeps a queue from stalling)
 *   5. the sender is in `usernames` (exact, case-insensitive)
 *   6. the text contains a `words` entry (substring, case-insensitive)
 */
export function chatTtsShouldSpeak(
    message: { username?: string; text?: string },
    config: ChatTtsConfig,
): boolean {
    if (!config.enabled) return false;
    const text = messageText(message);
    if (!text) return false;
    if (text.startsWith("!")) return false;
    if (/^(https?:\/\/|www\.)/i.test(text)) return false;
    if (text.length > 200) return false;

    const username = (message.username ?? "").trim().toLowerCase();
    if (username && config.usernames.includes(username)) return false;

    const lower = text.toLowerCase();
    return !config.words.some((word) => lower.includes(word));
}
