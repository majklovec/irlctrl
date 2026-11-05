// i18n catalog maintenance: check, extract, update, normalize and dedupe.
//
// Every catalog directory (the core `i18n/` plus each `<root>/<id>/i18n/` of
// MODULE_ROOTS) holds one flat `<lang>.json` per language; English (`en.json`)
// is the source of truth for the key set.
//
//   bun scripts/i18n.ts check [--strict]
//       Report structural errors (missing/extra keys vs en, placeholder
//       mismatches, duplicate JSON keys, keys owned by two catalogs, empty
//       values) and warnings (values identical to English, mergeable
//       duplicate keys, keys without a literal reference in the source).
//       Exits 1 on errors (or on warnings too with --strict).
//
//   bun scripts/i18n.ts export [--out FILE] [--untranslated] [--catalog DIR]
//       Extract every key and its value in all languages into one JSON file
//       (default i18n.export.json): { "<catalog dir>": { "<key>": { "<lang>": "..." } } }.
//       --untranslated keeps only keys missing in, or identical to English in,
//       some language.
//
//   bun scripts/i18n.ts import FILE
//       Apply a (possibly partial) file in the export format back to the
//       catalogs: each given value overwrites that key in that language. A key
//       new to a catalog needs an "en" value; "en": null removes the key from
//       every language. The catalogs are then normalized like `sync`.
//
//   bun scripts/i18n.ts sync
//       Normalize every catalog: drop keys English does not have, fill missing
//       ones with the English text, order keys as in en.json, rewrite keeping
//       each file's indentation.
//
//   bun scripts/i18n.ts dedupe [--apply]
//       Find keys of one catalog whose text is identical in every language and
//       merge each group into one key, rewriting the quoted key literals in the
//       source. Keys built dynamically (`prefix.${…}`), plural forms and keys
//       without a literal reference are never removed. Dry run without --apply.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LANGUAGE, LANGUAGES } from "../shared/languages";
import { MODULE_ROOTS } from "../shared/paths";

type Catalog = Record<string, string>;
type Export = Record<string, Record<string, Record<string, string | null>>>;

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const EN = DEFAULT_LANGUAGE;
const OTHERS = LANGUAGES.filter((lang) => lang !== EN);
const PLURAL = /_(zero|one|two|few|many|other)$/;
const SOURCE_EXT = /\.(ts|tsx|js|mjs|json|html)$/;
/** Directory names never scanned, and app-root directories holding only data. */
const SKIP_DIRS = new Set(["node_modules", "dist", "i18n"]);
const SKIP_ROOT_DIRS = new Set(["armbian", "TODO", "docs"]);

/** Every catalog directory, relative to the app root (core first). */
function catalogDirs(): string[] {
    const dirs = ["i18n"];
    for (const root of MODULE_ROOTS)
        for (const entry of readdirSync(join(ROOT, root)).sort()) {
            const dir = `${root}/${entry}/i18n`;
            if (existsSync(join(ROOT, dir, `${EN}.json`))) dirs.push(dir);
        }
    return dirs;
}

const fileOf = (dir: string, lang: string) => join(ROOT, dir, `${lang}.json`);

/** Keys appearing more than once in the raw JSON text (JSON.parse keeps the last). */
function duplicateJsonKeys(text: string): string[] {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const match of text.matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)) {
        const key = JSON.parse(match[1] as string) as string;
        if (seen.has(key)) dups.add(key);
        seen.add(key);
    }
    return [...dups];
}

function readCatalog(dir: string, lang: string): Catalog {
    const file = fileOf(dir, lang);
    return existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as Catalog)
        : {};
}

/** All languages of one catalog directory. */
function readAll(dir: string): Record<string, Catalog> {
    return Object.fromEntries(
        LANGUAGES.map((lang) => [lang, readCatalog(dir, lang)]),
    );
}

/** Write a catalog in en.json key order; returns whether the file changed. */
function writeCatalog(
    dir: string,
    lang: string,
    data: Catalog,
    order: string[],
): boolean {
    const ordered: Catalog = {};
    for (const key of order) if (key in data) ordered[key] = data[key] as string;
    const file = fileOf(dir, lang);
    const previous = existsSync(file) ? readFileSync(file, "utf8") : null;
    // Keep the file's own indentation (4 spaces for new files).
    const indent = previous?.match(/^\{\r?\n([ \t]+)"/)?.[1] ?? "    ";
    const text = `${JSON.stringify(ordered, null, indent)}\n`;
    if (previous === text) return false;
    writeFileSync(file, text);
    return true;
}

/** Normalize one catalog directory against its English key set. */
function syncDir(dir: string, all = readAll(dir)): string[] {
    const en = all[EN] as Catalog;
    const order = Object.keys(en);
    const changed: string[] = [];
    for (const lang of LANGUAGES) {
        const current = all[lang] as Catalog;
        const next: Catalog = {};
        for (const key of order) {
            const value = current[key];
            next[key] =
                typeof value === "string" && value.trim() !== ""
                    ? value
                    : (en[key] as string);
        }
        if (writeCatalog(dir, lang, next, order)) changed.push(`${dir}/${lang}.json`);
    }
    return changed;
}

const placeholders = (value: string) =>
    [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
        .map((match) => match[1])
        .sort()
        .join(",");

// ---------------------------------------------------------------- sources

function sourceFiles(dir = ROOT, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (
                !SKIP_DIRS.has(entry.name) &&
                !(dir === ROOT && SKIP_ROOT_DIRS.has(entry.name))
            )
                sourceFiles(path, out);
        } else if (SOURCE_EXT.test(entry.name) && path !== SELF) out.push(path);
    }
    return out;
}

interface SourceIndex {
    files: Map<string, string>;
    dynamicPrefixes: string[];
    references(key: string): number;
}

function indexSources(): SourceIndex {
    const files = new Map<string, string>();
    for (const file of sourceFiles()) files.set(file, readFileSync(file, "utf8"));
    const prefixes = new Set<string>();
    for (const text of files.values()) {
        // `prefix.${x}` / `prefix_${x}` template literals and "prefix." + x
        for (const m of text.matchAll(/`([a-z][\w.]*[._])\$\{/g))
            prefixes.add(m[1] as string);
        for (const m of text.matchAll(/["']([a-z][\w.]*[._])["']\s*\+/g))
            prefixes.add(m[1] as string);
    }
    const counts = new Map<string, number>();
    const literal = /(["'`])([a-z][\w.-]*)\1/gi;
    for (const text of files.values())
        for (const m of text.matchAll(literal))
            counts.set(m[2] as string, (counts.get(m[2] as string) ?? 0) + 1);
    return {
        files,
        dynamicPrefixes: [...prefixes],
        references: (key) => counts.get(key) ?? 0,
    };
}

const isDynamic = (key: string, index: SourceIndex) =>
    index.dynamicPrefixes.some((prefix) => key.startsWith(prefix));

// ---------------------------------------------------------------- dedupe

interface MergeGroup {
    dir: string;
    text: string;
    canonical: string;
    removed: string[];
}

/** Groups of keys whose text is identical in every language, per catalog. */
function findMerges(index: SourceIndex): MergeGroup[] {
    const allKeys = new Set<string>();
    const data = new Map<string, Record<string, Catalog>>();
    for (const dir of catalogDirs()) {
        const all = readAll(dir);
        data.set(dir, all);
        for (const key of Object.keys(all[EN] as Catalog)) allKeys.add(key);
    }
    const groups: MergeGroup[] = [];
    for (const [dir, all] of data) {
        const bySignature = new Map<string, string[]>();
        for (const key of Object.keys(all[EN] as Catalog)) {
            const signature = JSON.stringify(
                LANGUAGES.map((lang) => all[lang]?.[key]),
            );
            bySignature.set(signature, [
                ...(bySignature.get(signature) ?? []),
                key,
            ]);
        }
        for (const keys of bySignature.values()) {
            if (keys.length < 2) continue;
            // Only literally referenced, statically named, non-plural keys can go.
            const movable = keys.filter(
                (key) =>
                    !PLURAL.test(key) &&
                    !isDynamic(key, index) &&
                    index.references(key) > 0,
            );
            // A dynamically built key is live, so it may absorb a lone duplicate;
            // a key nothing references is left alone.
            const live = keys.find(
                (key) => !movable.includes(key) && isDynamic(key, index),
            );
            let canonical: string;
            if (movable.length >= 2)
                canonical = pickCanonical(movable, allKeys, index);
            else if (movable.length === 1 && live) canonical = live;
            else continue;
            const removed = movable.filter((key) => key !== canonical);
            if (removed.length === 0) continue;
            groups.push({
                dir,
                text: (all[EN] as Catalog)[keys[0] as string] as string,
                canonical,
                removed,
            });
        }
    }
    return groups;
}

/**
 * The surviving key of a group: a shared generic name when the keys only
 * differ by an element prefix (`overlay.cd_event_link`, `overlay.sw_event_link`
 * → `overlay.event_link`), else a `ui.*` key, else the most referenced one.
 */
function pickCanonical(
    keys: string[],
    allKeys: Set<string>,
    index: SourceIndex,
): string {
    const split = keys.map((key) => {
        const dot = key.lastIndexOf(".");
        const last = key.slice(dot + 1);
        return { ns: key.slice(0, dot), suffix: last.slice(last.indexOf("_") + 1) };
    });
    const first = split[0];
    if (
        first &&
        first.ns &&
        split.every((s) => s.ns === first.ns && s.suffix === first.suffix)
    ) {
        const generic = `${first.ns}.${first.suffix}`;
        if (keys.includes(generic)) return generic;
        if (
            !allKeys.has(generic) &&
            !isDynamic(generic, index) &&
            index.references(generic) === 0
        )
            return generic;
    }
    const ui = keys.find((key) => key.startsWith("ui."));
    if (ui) return ui;
    return [...keys].sort(
        (a, b) =>
            index.references(b) - index.references(a) ||
            a.length - b.length ||
            keys.indexOf(a) - keys.indexOf(b),
    )[0] as string;
}

function applyMerges(groups: MergeGroup[], index: SourceIndex): void {
    // Rewrite the catalogs: the canonical key takes the place of the first key.
    for (const dir of new Set(groups.map((g) => g.dir))) {
        const all = readAll(dir);
        const en = all[EN] as Catalog;
        let order = Object.keys(en);
        for (const group of groups.filter((g) => g.dir === dir)) {
            const members = [group.canonical, ...group.removed];
            const at = Math.min(
                ...members.map((k) => order.indexOf(k)).filter((i) => i >= 0),
            );
            const source = members.find((k) => k in en) as string;
            order = order.filter((k) => !members.includes(k));
            order.splice(at, 0, group.canonical);
            for (const lang of LANGUAGES) {
                const catalog = all[lang] as Catalog;
                catalog[group.canonical] = catalog[source] as string;
                for (const key of group.removed) delete catalog[key];
            }
        }
        for (const lang of LANGUAGES)
            writeCatalog(dir, lang, all[lang] as Catalog, order);
    }
    // Rewrite every quoted literal of a removed key in the source.
    const rename = new Map<string, string>();
    for (const group of groups)
        for (const key of group.removed) rename.set(key, group.canonical);
    const literal = /(["'`])([a-z][\w.-]*)\1/gi;
    for (const [file, text] of index.files) {
        const next = text.replace(literal, (whole, quote: string, key: string) => {
            const target = rename.get(key);
            return target ? `${quote}${target}${quote}` : whole;
        });
        if (next !== text) {
            writeFileSync(file, next);
            console.log(`  rewrote ${relative(ROOT, file)}`);
        }
    }
}

// ---------------------------------------------------------------- commands

function check(strict: boolean): number {
    let errors = 0;
    let warnings = 0;
    const error = (message: string) => {
        errors++;
        console.log(`ERROR  ${message}`);
    };
    const warn = (message: string) => {
        warnings++;
        console.log(`warn   ${message}`);
    };
    const owners = new Map<string, string>();
    const index = indexSources();
    for (const dir of catalogDirs()) {
        for (const lang of LANGUAGES) {
            const file = fileOf(dir, lang);
            if (!existsSync(file)) {
                error(`${dir}/${lang}.json: missing file`);
                continue;
            }
            for (const key of duplicateJsonKeys(readFileSync(file, "utf8")))
                error(`${dir}/${lang}.json: duplicate JSON key ${key}`);
        }
        const all = readAll(dir);
        const en = all[EN] as Catalog;
        for (const key of Object.keys(en)) {
            const owner = owners.get(key);
            if (owner) error(`${key}: defined in both ${owner} and ${dir}`);
            owners.set(key, dir);
            if (!(en[key] ?? "").trim()) error(`${dir}/en.json: empty ${key}`);
            if (
                !PLURAL.test(key) &&
                !isDynamic(key, index) &&
                index.references(key) === 0
            )
                warn(`${dir}: ${key} has no literal reference in the source`);
        }
        for (const lang of OTHERS) {
            const catalog = all[lang] as Catalog;
            for (const key of Object.keys(en)) {
                const value = catalog[key];
                if (value === undefined) {
                    error(`${dir}/${lang}.json: missing ${key}`);
                    continue;
                }
                if (!value.trim()) error(`${dir}/${lang}.json: empty ${key}`);
                if (placeholders(value) !== placeholders(en[key] as string))
                    error(`${dir}/${lang}.json: placeholders of ${key} differ from en`);
                if (value === en[key])
                    warn(`${dir}/${lang}.json: ${key} same as English ${JSON.stringify(value)}`);
            }
            for (const key of Object.keys(catalog))
                if (!(key in en)) error(`${dir}/${lang}.json: extra key ${key}`);
        }
    }
    for (const group of findMerges(index))
        warn(
            `${group.dir}: ${[group.canonical, ...group.removed].join(", ")} share ${JSON.stringify(group.text)} in every language (dedupe)`,
        );
    console.log(`\n${errors} error(s), ${warnings} warning(s)`);
    return errors > 0 || (strict && warnings > 0) ? 1 : 0;
}

function exportCatalogs(out: string, untranslated: boolean, only?: string): void {
    const result: Export = {};
    let count = 0;
    for (const dir of catalogDirs()) {
        if (only && dir !== only) continue;
        const all = readAll(dir);
        const en = all[EN] as Catalog;
        const entries: Export[string] = {};
        for (const key of Object.keys(en)) {
            if (
                untranslated &&
                !OTHERS.some((lang) => {
                    const value = all[lang]?.[key];
                    return value === undefined || value === en[key];
                })
            )
                continue;
            entries[key] = Object.fromEntries(
                LANGUAGES.map((lang) => [lang, all[lang]?.[key] ?? null]),
            );
            count++;
        }
        if (Object.keys(entries).length) result[dir] = entries;
    }
    writeFileSync(out, `${JSON.stringify(result, null, 4)}\n`);
    console.log(`exported ${count} key(s) to ${out}`);
}

function importCatalogs(file: string): void {
    const input = JSON.parse(readFileSync(file, "utf8")) as Export;
    const known = new Set(catalogDirs());
    let updated = 0;
    for (const [dir, entries] of Object.entries(input)) {
        if (!known.has(dir)) throw new Error(`unknown catalog ${dir}`);
        const all = readAll(dir);
        const en = all[EN] as Catalog;
        for (const [key, values] of Object.entries(entries)) {
            if (values[EN] === null) {
                for (const lang of LANGUAGES) delete all[lang]?.[key];
                updated++;
                continue;
            }
            if (!(key in en) && typeof values[EN] !== "string")
                throw new Error(`${dir}: new key ${key} needs an "${EN}" value`);
            for (const [lang, value] of Object.entries(values)) {
                if (!(LANGUAGES as readonly string[]).includes(lang))
                    throw new Error(`${dir}: unknown language ${lang} for ${key}`);
                if (typeof value !== "string") continue;
                (all[lang] as Catalog)[key] = value;
                updated++;
            }
        }
        for (const path of syncDir(dir, all)) console.log(`  wrote ${path}`);
    }
    console.log(`imported ${updated} value(s) from ${file}`);
}

function main(argv: string[]): number {
    const [command = "check", ...rest] = argv;
    const flag = (name: string) => rest.includes(name);
    const option = (name: string) => {
        const at = rest.indexOf(name);
        return at >= 0 ? rest[at + 1] : undefined;
    };
    switch (command) {
        case "check":
            return check(flag("--strict"));
        case "export":
            exportCatalogs(
                option("--out") ?? "i18n.export.json",
                flag("--untranslated"),
                option("--catalog"),
            );
            return 0;
        case "import": {
            const file = rest.find((arg) => !arg.startsWith("--"));
            if (!file) throw new Error("usage: bun scripts/i18n.ts import FILE");
            importCatalogs(file);
            return 0;
        }
        case "sync": {
            const changed = catalogDirs().flatMap((dir) => syncDir(dir));
            for (const path of changed) console.log(`  wrote ${path}`);
            console.log(`synced, ${changed.length} file(s) changed`);
            return 0;
        }
        case "dedupe": {
            const index = indexSources();
            const groups = findMerges(index);
            for (const g of groups)
                console.log(
                    `${g.dir}: ${JSON.stringify(g.text)} → ${g.canonical} (drops ${g.removed.join(", ")})`,
                );
            if (flag("--apply") && groups.length) applyMerges(groups, index);
            console.log(
                `${groups.length} group(s)${flag("--apply") ? " merged" : " (dry run, pass --apply)"}`,
            );
            return 0;
        }
        default:
            console.error(
                "usage: bun scripts/i18n.ts check|export|import|sync|dedupe [options]",
            );
            return 2;
    }
}

process.exit(main(process.argv.slice(2)));
