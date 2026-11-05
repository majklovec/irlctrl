import { describe, expect, test } from "bun:test";
import {
    CHAT_CONFIG_FIELDS,
    chatBadgesFromConfig,
    chatPlatformIconsFromConfig,
} from "../server/pages/dashboards/modules/chat/config";

describe("chat platform icons", () => {
    test("declares automatic, show and hide choices", () => {
        expect(CHAT_CONFIG_FIELDS).toContainEqual({
            name: "platformIcons",
            type: "select",
            options: ["auto", "on", "off"],
        });
    });

    test("preserves automatic visibility for missing, empty and invalid settings", () => {
        const configs: (Record<string, string> | undefined)[] = [
            undefined,
            {},
            { platformIcons: "" },
            { platformIcons: "auto" },
            { platformIcons: "invalid" },
        ];
        for (const config of configs) {
            expect(chatPlatformIconsFromConfig(config, 0)).toBe(false);
            expect(chatPlatformIconsFromConfig(config, 1)).toBe(false);
            expect(chatPlatformIconsFromConfig(config, 2)).toBe(true);
        }
    });

    test("can show icons for a single platform", () => {
        expect(chatPlatformIconsFromConfig({ platformIcons: "on" }, 1)).toBe(
            true,
        );
        expect(chatPlatformIconsFromConfig({ platformIcons: " ON " }, 2)).toBe(
            true,
        );
    });

    test("can hide icons for multiple platforms", () => {
        expect(chatPlatformIconsFromConfig({ platformIcons: "off" }, 1)).toBe(
            false,
        );
        expect(chatPlatformIconsFromConfig({ platformIcons: " OFF " }, 4)).toBe(
            false,
        );
    });
});

describe("chat sender badges", () => {
    test("declares the show/hide choice", () => {
        expect(CHAT_CONFIG_FIELDS).toContainEqual({
            name: "badges",
            type: "select",
            options: ["off", "on"],
        });
    });

    test("shows badges unless explicitly off", () => {
        for (const config of [
            undefined,
            {},
            { badges: "" },
            { badges: "on" },
            { badges: "invalid" },
        ]) {
            expect(chatBadgesFromConfig(config)).toBe(true);
        }
        expect(chatBadgesFromConfig({ badges: "off" })).toBe(false);
        expect(chatBadgesFromConfig({ badges: " OFF " })).toBe(false);
    });
});

