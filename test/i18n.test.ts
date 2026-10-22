import { describe, expect, test } from "bun:test";
import { LANGUAGES } from "../shared/languages";
import { i18nReady, translate } from "../shared/i18n";

describe("i18next translation options", () => {
    test("every locale matches the English keys and placeholders", async () => {
        const base = (await Bun.file(
            new URL("../i18n/en.json", import.meta.url),
        ).json()) as Record<string, string>;
        const baseKeys = Object.keys(base).sort();

        for (const language of LANGUAGES) {
            const catalog = (await Bun.file(
                new URL(`../i18n/${language}.json`, import.meta.url),
            ).json()) as Record<string, string>;
            expect(Object.keys(catalog).sort(), language).toEqual(baseKeys);

            for (const key of baseKeys) {
                const placeholders = (value: string) =>
                    [...value.matchAll(/\{\{(\w+)\}\}/g)]
                        .map((match) => match[1])
                        .sort();
                expect(placeholders(catalog[key]), `${language}: ${key}`).toEqual(
                    placeholders(base[key]),
                );
            }
        }
    });

    test("interpolates named values", async () => {
        await i18nReady;
        expect(
            translate("en", "log.stream_start_retry", {
                delay: 5,
                error: "network",
            }),
        ).toBe("Start failed, retrying in 5s: network");
    });

    test("uses locale-aware plural forms with count", async () => {
        await i18nReady;
        expect(translate("en", "set.pipeline_count", { count: 1 })).toBe(
            "1 pipeline",
        );
        expect(translate("en", "set.pipeline_count", { count: 2 })).toBe(
            "2 pipelines",
        );
    });
});
