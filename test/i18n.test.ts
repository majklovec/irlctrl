import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { catalog, i18nReady, translate } from "../shared/i18n";
import { LANGUAGES } from "../shared/languages";
import { MODULE_ROOTS } from "../shared/paths";

const root = new URL("../", import.meta.url);

/** Every catalog directory: the core `i18n/` plus each `<root>/<id>/i18n/`. */
function catalogDirs(): { name: string; dir: URL }[] {
    const dirs = [{ name: "core", dir: new URL("i18n/", root) }];
    for (const moduleRoot of MODULE_ROOTS)
        for (const entry of readdirSync(new URL(`${moduleRoot}/`, root), {
            withFileTypes: true,
        }).sort((a, b) => a.name.localeCompare(b.name))) {
            const dir = new URL(`${moduleRoot}/${entry.name}/i18n/`, root);
            if (entry.isDirectory() && existsSync(dir))
                dirs.push({ name: entry.name, dir });
        }
    return dirs;
}

const readCatalog = (dir: URL, lang: string) =>
    Bun.file(new URL(`${lang}.json`, dir)).json() as Promise<
        Record<string, string>
    >;

describe("i18next translation options", () => {
    test("every catalog (core and per module) has every locale with the English keys and placeholders", async () => {
        const placeholders = (value: string) =>
            [...value.matchAll(/\{\{(\w+)\}\}/g)]
                .map((match) => match[1])
                .sort();
        for (const { name, dir } of catalogDirs()) {
            const base = await readCatalog(dir, "en");
            const baseKeys = Object.keys(base).sort();
            expect(baseKeys.length, `${name}: empty catalog`).toBeGreaterThan(
                0,
            );
            for (const language of LANGUAGES) {
                const catalog = await readCatalog(dir, language);
                expect(
                    Object.keys(catalog).sort(),
                    `${name}/${language}`,
                ).toEqual(baseKeys);
                for (const key of baseKeys)
                    expect(
                        placeholders(catalog[key]),
                        `${name}/${language}: ${key}`,
                    ).toEqual(placeholders(base[key]));
            }
        }
    });

    test("catalog keys are disjoint across the core and the modules", async () => {
        const owners = new Map<string, string>();
        for (const { name, dir } of catalogDirs())
            for (const key of Object.keys(await readCatalog(dir, "en"))) {
                expect(owners.get(key), `${key} in ${name}`).toBeUndefined();
                owners.set(key, name);
            }
    });

    test("the merged catalog served to the browser contains the module keys", async () => {
        const merged = await catalog("en");
        expect(merged).not.toBeNull();
        for (const { name, dir } of catalogDirs())
            for (const key of Object.keys(await readCatalog(dir, "en")))
                expect(merged?.[key], `${name}: ${key}`).toBeDefined();
    });

    for (const language of LANGUAGES.filter((lang) => lang !== "en")) {
        test(`project and overlay text is localized in ${language}`, async () => {
            const keys = [
                "mgmt.projects",
                "overlay.create_new",
                "overlay.export_overlay",
                "overlay.import_invalid_file",
                "overlay.import_overlay",
                "overlay.zoom_fit",
                "profile.language.title",
                "projects.create_new",
                "projects.created",
                "projects.delete",
                "projects.delete_confirm",
                "projects.empty",
                "projects.invites.create",
                "projects.invites.empty",
                "projects.invites.revoke",
                "projects.invites.title",
                "projects.join.accept",
                "projects.join.failed",
                "projects.join.joined",
                "projects.join.open",
                "projects.join.title",
                "projects.members.remove",
                "projects.members.title",
                "projects.new_name",
                "projects.new_placeholder",
                "projects.rename",
                "projects.renamed",
                "projects.role.owner",
                "projects.role.viewer",
                "projects.select.label",
                "projects.select.placeholder",
                "projects.title",
                "projects.you",
            ];
            const options = {
                name: "Example",
                project: "Example",
                role: "Editor",
            };
            await i18nReady;
            expect(await catalog(language)).not.toBeNull();
            for (const key of keys)
                expect(translate(language, key, options), `${language}: ${key}`)
                    .not.toBe(translate("en", key, options));
            expect(
                translate(language, "projects.delete_confirm", options),
            ).toContain(options.name);
            const joined = translate(language, "projects.join.joined", options);
            expect(joined).toContain(options.project);
            expect(joined).toContain(options.role);
        });
    }

    test("Czech action labels use the intended meaning", async () => {
        await catalog("cs");
        expect(translate("cs", "dash.delete")).toBe("Smazat");
        expect(translate("cs", "mlog.action.delete")).toBe("Smazat");
        expect(translate("cs", "assets.uploading")).toBe("Nahrávání…");
        expect(translate("cs", "overlay.opacity")).toBe("Krytí");
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
