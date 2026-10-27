// i18n core for the Bun runtimes (control server, compiled device binary),
// built on i18next.
//
// A language's catalog is the merge of the core catalog (`i18n/<lang>.json`,
// English in i18n/en.json is the source of truth) and every module's own
// catalog (`modules/<id>/i18n/<lang>.json`): modules ship their translations
// next to their code and the core never names a module. Keys are flat and
// disjoint by construction (test/i18n.test.ts pins it). Only the default
// language is loaded eagerly; every other language is read on demand the
// first time it is requested and cached.
//
// The catalogs are resolved in two ways:
//   * unbundled (bun backend/server/server.ts, dev, tests): read from disk —
//     the core file plus a scan of modules/*/i18n/;
//   * compiled binaries (bun build --compile): the build-time manifest
//     generated/i18n.ts (scripts/gen-modules.ts) inlines every catalog, as a
//     flat binary cannot scan a directory.
//
// The browser loads the same merged catalogs on demand from /i18n/<lang>.json
// (see frontend/ts/i18n.tsx) using the i18next-http-backend plugin over HTTP.
// This core deliberately does not: the plugin routes only http(s) URLs through
// fetch, and it has nothing to fetch from before the HTTP server starts —
// including the synchronous `--help` path.
//
// t()/translate() use i18next's options-object API with named interpolation
// values. Missing keys fall back to English, then to the raw key.

import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import i18next, { type TOptions } from "i18next";
import {
	asLanguage,
	DEFAULT_LANGUAGE,
	isLanguage,
	type Language,
} from "./languages";
import { setLogTranslator } from "./logMessages";
import { isCompiledBinary } from "./util";

export type { Language } from "./languages";
export {
	asLanguage,
	DEFAULT_LANGUAGE,
	isLanguage,
	LANGUAGE_INFO,
	LANGUAGES,
} from "./languages";

const i18n = i18next.createInstance();

const MODULES_DIR = fileURLToPath(new URL("../modules/", import.meta.url));

type Catalog = Record<string, string>;

/** The core catalog file plus every module's catalog for `lng` (unbundled). */
function catalogFiles(lng: Language): string[] {
	const files = [fileURLToPath(new URL(`../i18n/${lng}.json`, import.meta.url))];
	for (const entry of readdirSync(MODULES_DIR).sort()) {
		const file = `${MODULES_DIR}${entry}/i18n/${lng}.json`;
		if (existsSync(file)) files.push(file);
	}
	return files;
}

/** Every catalog contributing to `lng`, in merge order (core first). */
async function catalogParts(lng: Language): Promise<Catalog[]> {
	if (isCompiledBinary()) {
		const manifest = (
			(await import("../generated/i18n")) as {
				default: Record<string, Catalog[]>;
			}
		).default;
		const parts = manifest[lng];
		if (!parts) throw new Error(`missing i18n catalog for ${lng}`);
		return parts;
	}
	return Promise.all(
		catalogFiles(lng).map((file) => Bun.file(file).json() as Promise<Catalog>),
	);
}

const cached = new Map<Language, Catalog>();
const inFlight = new Map<Language, Promise<Catalog>>();

/** The English catalog, loaded once at startup so i18next has a fallback. */
const initGate: Promise<void> = (async () => {
	const en = await readRaw(DEFAULT_LANGUAGE);
	cached.set(DEFAULT_LANGUAGE, en);
	await i18n.init({
		resources: { en: { translation: en } },
		lng: DEFAULT_LANGUAGE,
		fallbackLng: DEFAULT_LANGUAGE,
		// Keys are flat strings that may contain dots, so no path splitting.
		keySeparator: false,
		nsSeparator: false,
		interpolation: { escapeValue: false },
		returnNull: false,
	});
})();

export const i18nReady: Promise<void> = initGate;

/** Read and merge a language's catalogs. */
async function readRaw(lng: Language): Promise<Catalog> {
	return Object.assign({}, ...(await catalogParts(lng))) as Catalog;
}

/**
 * Load a catalog into i18next, caching it and deduplicating concurrent reads.
 * The default language is served from the cache populated by `initGate`.
 */
function readCatalog(lng: Language): Promise<Catalog> {
	const hit = cached.get(lng);
	if (hit) return Promise.resolve(hit);
	const pending = inFlight.get(lng);
	if (pending) return pending;
	const load = (async () => {
		const bundle = await readRaw(lng);
		cached.set(lng, bundle);
		// Guard i18next's addResourceBundle behind init (the default language
		// is already inside `resources`, so this only runs for other languages).
		await initGate;
		i18n.addResourceBundle(lng, "translation", bundle, true, true);
		return bundle;
	})();
	const tracked = load.finally(() => inFlight.delete(lng));
	inFlight.set(lng, tracked);
	return tracked;
}

/** The language t() currently resolves to; set at startup and on change. */
let current: Language = DEFAULT_LANGUAGE;

/**
 * Switch t() to a language. Synchronous: `current` flips immediately (the
 * default English keeps working as a fallback) while the catalog loads in the
 * background, then i18next is pointed at it once the read settles.
 */
export function setCurrentLanguage(lang: unknown): void {
	current = asLanguage(lang);
	void readCatalog(current)
		.then(() => i18n.changeLanguage(current))
		.catch((error) =>
			console.error(`failed to load i18n catalog for ${current}`, error),
		);
}

/**
 * Translate a catalog key into a specific language. Unknown languages fall
 * back to English, unknown keys fall back to English, then to the raw key.
 */
export function translate(
	lang: unknown,
	key: string,
	options?: TOptions,
): string {
	return i18n.t(key, { ...options, lng: asLanguage(lang) }) as string;
}

/** Translate using the current language. */
export function t(key: string, options?: TOptions): string {
	return i18n.t(key, { ...options, lng: current }) as string;
}

// The shared log wording localizes through the installed translator.
setLogTranslator(t);

/**
 * The catalog for a language, for the device API (backend/client/api.ts) and the control
 * server (server.ts) to serve as /i18n/<lang>.json. Loads on demand and
 * caches. null for unknown codes.
 */
export function catalog(lang: string): Promise<Catalog | null> {
	return isLanguage(lang) ? readCatalog(lang) : Promise.resolve(null);
}
