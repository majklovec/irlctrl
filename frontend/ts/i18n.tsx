/* Browser i18n. Runs its own i18next instance whose catalogs are fetched on
 * demand by the i18next-http-backend plugin from /i18n/<lang>.json (served by
 * server.ts / the device API from the embedded catalogs). The plugin loads the
 * current and fallback languages during init and any further language on
 * changeLanguage. The initial language is detected by
 * i18next-browser-languagedetector: the persisted choice first, then the
 * navigator locale (regional variants folded to their base code). The header
 * <LanguageSelect> is the Mithril component that drives the switch: it
 * persists the choice, updates <html lang> and redraws. */

import i18next, { type TOptions } from "i18next";
import LanguageDetector, {
	type DetectorOptions,
} from "i18next-browser-languagedetector";
import httpBackend from "i18next-http-backend";
import m from "mithril";
import {
	asLanguage,
	DEFAULT_LANGUAGE,
	isLanguage,
	LANGUAGE_INFO,
	LANGUAGES,
	type Language,
} from "../../shared/languages";
import { setLogTranslator } from "../../shared/logMessages";
import type { MithrilJSXComponent } from "./jsx";

export type { Language };
export { LANGUAGES };

const STORAGE_KEY = "irlctrl-lang";

/**
 * Where the UI language is looked up: the persisted choice first, then the
 * navigator locale. Switches made through setLanguage are persisted to the
 * same key by the detector's caches, so the explicit choice always wins over
 * the locale on the next load.
 */
const detection: DetectorOptions = {
	order: ["localStorage", "navigator"],
	lookupLocalStorage: STORAGE_KEY,
	caches: ["localStorage"],
};

const i18n = i18next.createInstance();

// Same options as the instance i18next registers, so both look up identically.
const detector = new LanguageDetector(undefined, detection);

/**
 * The initial UI language: the persisted choice (irlctrl-lang) first, then
 * the navigator locale. "cs-CZ" is folded to "cs" and anything unsupported
 * falls back to the default language.
 */
function readInitial(): Language {
	const detected = detector.detect();
	const code = Array.isArray(detected) ? detected[0] : detected;
	const base = code?.split(/[-_]/)[0];
	return isLanguage(base) ? base : DEFAULT_LANGUAGE;
}

let current: Language = readInitial();
document.documentElement.lang = current;

const initPromise = i18n
	.use(httpBackend)
	.use(LanguageDetector)
	.init({
		lng: current,
		fallbackLng: DEFAULT_LANGUAGE,
		detection,
		backend: {
			// Absolute URL so non-browser fetch (Bun) and cross-origin hosts both
			// work; in the page this is same-origin.
			loadPath: (languages: string[]) =>
				`${window.location.origin}/i18n/${languages[0]}.json`,
			addPath: false,
			reloadInterval: false,
		},
		// Keys are flat strings that may contain dots, so no path splitting.
		keySeparator: false,
		nsSeparator: false,
		interpolation: { escapeValue: false },
		returnNull: false,
	});

/**
 * Resolves once i18next is initialized and the catalogs it loads on init
 * (the selected language plus the English fallback) have settled
 * (mountPage awaits this).
 */
export const i18nReady: Promise<void> = initPromise
	.then(
		() =>
			new Promise<void>((resolve, reject) =>
				i18n.loadResources((error) => (error ? reject(error) : resolve())),
			),
	)
	.then(() => undefined);

/** Translate using the current UI language and standard i18next options. */
export function t(key: string, options?: TOptions): string {
	return i18n.t(key, options) as string;
}

/** The current UI language (for ordering things like speech-voice lists). */
export const currentLanguage = (): Language => current;

// The shared log wording localizes through the installed translator.
setLogTranslator(t);

/** "🇨🇿 Čeština": flag and native name, the same whatever the UI language. */
export const languageLabel = (l: Language): string => {
	const info = LANGUAGE_INFO.find((i) => i.code === l);
	return info ? `${info.flag} ${info.name}` : l;
};

/**
 * Change the UI language: state, <html lang>, bundle, redraw. Persistence to
 * localStorage happens through the detector's caches on changeLanguage.
 */
export function setLanguage(next: string): void {
	const value = asLanguage(next);
	if (value === current) return;
	current = value;
	document.documentElement.lang = current;
	m.redraw(); // the select updates immediately, before the bundle lands
	void i18n
		.changeLanguage(current) // the http backend fetches the catalog
		.then(() => m.redraw())
		.catch((error) =>
			console.error(`failed to load i18n catalog for ${current}`, error),
		);
}

/** <option> per language, labelled by its flag and native name. */
export const languageOptions = () =>
	LANGUAGES.map((l) => (
		<option key={l} value={l}>
			{languageLabel(l)}
		</option>
	));

/** Header <select> listing every language by its flag and native name. */
const LanguageSelectComponent: m.Component = {
	view: () => (
		<select
			class="lang-select"
			aria-label={t("ui.language_label")}
			value={current}
			onchange={(e: Event) =>
				setLanguage((e.target as HTMLSelectElement).value)
			}
		>
			{languageOptions()}
		</select>
	),
};

export const LanguageSelect = LanguageSelectComponent as MithrilJSXComponent;
