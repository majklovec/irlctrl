import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { catalog, i18nReady, translate } from "../shared/i18n";
import { LANGUAGES } from "../shared/languages";

const root = new URL("../", import.meta.url);

/** Every catalog directory: the core `i18n/` plus each `modules/<id>/i18n/`. */
function catalogDirs(): { name: string; dir: URL }[] {
	const dirs = [{ name: "core", dir: new URL("i18n/", root) }];
	const modulesDir = new URL("modules/", root);
	for (const entry of readdirSync(modulesDir, { withFileTypes: true }).sort(
		(a, b) => a.name.localeCompare(b.name),
	)) {
		const dir = new URL(`modules/${entry.name}/i18n/`, root);
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
			[...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
		for (const { name, dir } of catalogDirs()) {
			const base = await readCatalog(dir, "en");
			const baseKeys = Object.keys(base).sort();
			expect(baseKeys.length, `${name}: empty catalog`).toBeGreaterThan(0);
			for (const language of LANGUAGES) {
				const catalog = await readCatalog(dir, language);
				expect(Object.keys(catalog).sort(), `${name}/${language}`).toEqual(
					baseKeys,
				);
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
