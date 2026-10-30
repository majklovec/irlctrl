import { describe, expect, test } from "bun:test";
import { CHAT_CONFIG_FIELDS, chatPlatformIconsFromConfig } from "../modules/chat/config";

describe("chat platform icons", () => {
    test("declares automatic, show and hide choices", () => {
        expect(CHAT_CONFIG_FIELDS).toContainEqual({
            name: "platformIcons",
            type: "select",
            options: ["auto", "on", "off"],
        });
    });

    test("preserves automatic visibility for missing, empty and invalid settings", () => {
        for (const config of [undefined, {}, { platformIcons: "" }, { platformIcons: "auto" }, { platformIcons: "invalid" }]) {
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
