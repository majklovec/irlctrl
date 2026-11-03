import { describe, expect, test } from "bun:test";
import {
    CHAT_CONFIG_FIELDS,
    chatPlatformIconsFromConfig,
    chatPropsToConfig,
    chatSpecsFromChannels,
    normalizeChannels,
    type ChatChannel,
} from "../server/modules/chat/config";

describe("chat platform icons", () => {
    test("declares automatic, show and hide choices", () => {
        expect(CHAT_CONFIG_FIELDS).toContainEqual({
            name: "platformIcons",
            type: "select",
            options: ["auto", "on", "off"],
        });
    });

    test("preserves automatic visibility for missing, empty and invalid settings", () => {
        const configs: (Record<string, string> | undefined)[] = [undefined, {}, { platformIcons: "" }, { platformIcons: "auto" }, { platformIcons: "invalid" }];
        for (const config of configs) {
            expect(chatPlatformIconsFromConfig(config, 0)).toBe(false);
            expect(chatPlatformIconsFromConfig(config, 1)).toBe(false);
            expect(chatPlatformIconsFromConfig(config, 2)).toBe(true);
        }
    });

    test("can show icons for a single platform", () => {
        expect(chatPlatformIconsFromConfig({ platformIcons: "on" }, 1)).toBe(true);
        expect(chatPlatformIconsFromConfig({ platformIcons: " ON " }, 2)).toBe(true);
    });

    test("can hide icons for multiple platforms", () => {
        expect(chatPlatformIconsFromConfig({ platformIcons: "off" }, 1)).toBe(false);
        expect(chatPlatformIconsFromConfig({ platformIcons: " OFF " }, 4)).toBe(false);
    });
});

describe("chat element channel list", () => {
    test("normalizes channels: keeps known-platform rows (empty handles become ''), drops unknown platforms and non-objects", () => {
        expect(
            normalizeChannels([
                { platform: "twitch", channel: " Some Streamer " },
                { platform: "kick", channel: "handle" },
                { platform: "hulu", channel: "nope" },
                { platform: "youtube", channel: "   " },
                { platform: "tiktok", channel: 42 as unknown as string },
                "not-an-object",
                null,
            ]),
        ).toEqual<ChatChannel[]>([
            { platform: "twitch", channel: "some streamer" },
            { platform: "kick", channel: "handle" },
            { platform: "youtube", channel: "" },
            { platform: "tiktok", channel: "" },
        ]);
    });

    test("treats non-array and empty input as no channels", () => {
        expect(normalizeChannels(undefined)).toEqual([]);
        expect(normalizeChannels("nope")).toEqual([]);
        expect(normalizeChannels([])).toEqual([]);
    });

    test("chatSpecsFromChannels renders specs and skips empty handles", () => {
        expect(
            chatSpecsFromChannels([
                { platform: "twitch", channel: "alice" },
                { platform: "youtube", channel: "creator" },
                { platform: "kick", channel: "" },
            ]),
        ).toEqual(["twitch:alice", "youtube:creator"]);
    });

    test("chatPropsToConfig rebuilds a widget-shaped config from element props", () => {
        const config = chatPropsToConfig({
            channels: [{ platform: "twitch", channel: " Alice " }],
            order: "bottom",
            bannedMessages: "hide",
            timestamps: "on",
            platformIcons: "on",
        });
        expect(config).toEqual({
            twitch: "alice",
            order: "bottom",
            bannedMessages: "hide",
            timestamps: "on",
            platformIcons: "on",
        });
    });

    test("chatPropsToConfig falls back to defaults for missing/invalid props", () => {
        const config = chatPropsToConfig({ channels: [] });
        expect(config).toEqual({
            order: "top",
            bannedMessages: "strike",
            timestamps: "off",
            platformIcons: "auto",
        });
    });
});
