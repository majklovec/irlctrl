/*
 * The template config builder: the single source for "what does this
 * element's state contribute to the doc". Turns one template's metadata +
 * one normalized element props object into a TemplateConfig — the set of
 * CSS vars, bound text, asset srcs, and countdown target that the doc
 * renderer (render_doc.ts) bakes, entity-escaped, into the in-page markup.
 *
 * Emission order is fixed (insertion order is the element's doc-cache key
 * order) and every entry is filtered through `meta.uses`, so two inputs
 * that differ only in unused props produce the identical config — editing
 * a prop the template does not consume must not rebuild (or restart) the
 * document.
 *
 * PURE by contract: no DOM, no Mithril, no browser globals. User text
 * reaches the output verbatim from the `text`/`assets` inputs — escaping
 * happens in render_doc.ts, the only place the config meets markup.
 */

import type { TemplateMeta, TemplateParam } from "./templates/template_meta";

/** One normalized `uses` member → its CSS custom property. A var is emitted
 * only when the template uses it (keeps unrelated edits out of the doc). */
type VarWriter = (props: Record<string, unknown>) => string;

const VAR_WRITERS: Readonly<Record<TemplateParam, VarWriter | null>> = {
	title: null, // text, not a var
	subtitle: null, // text, not a var
	accentColor: (p) => hex(p.accentColor),
	bgColor: (p) => {
		// hex has no alpha channel — bgAlpha carries it as a percent
		const [r, g, b] = hexChannels(hex(p.bgColor));
		const a = Math.round(num(p.bgAlpha, 100)) / 100;
		return `rgba(${r}, ${g}, ${b}, ${a})`;
	},
	bgAlpha: null, // folds into --bg (see bgColor)
	textColor: (p) => hex(p.textColor),
	fontFamily: (p) => str(p.fontFamily),
	fontSize: (p) => `${num(p.fontSize, 0)}px`,
	radius: (p) => `${num(p.radius, 0)}px`,
	padding: (p) => `${num(p.padding, 0)}px`,
	logoAssetId: null, // asset, not a var
	mode: null, // countdown, not a var
	targetIso: null, // countdown, not a var
	// `vars` is not a named writer — it is the user's own `:root` overrides,
	// merged in buildTemplateConfig when the template's `uses` has "vars"
	vars: null,
};

const VAR_NAMES: Readonly<Record<string, string>> = {
	accentColor: "--accent",
	bgColor: "--bg",
	textColor: "--text",
	fontFamily: "--font",
	fontSize: "--font-size",
	radius: "--radius",
	padding: "--padding",
};

/** Props that render as bound TEXT (baked into the markup's
 * `[data-bind]` slots; tokens already interpolated by the caller —
 * see TemplateDocInput.text). */
const TEXT_PARAMS: readonly TemplateParam[] = ["title", "subtitle"];

/** Resolve ONE props record through every named style writer (no
 * uses-gate, no text/asset/countdown). The schema's legacy migration uses
 * this to fold pre-`vars` scenes' named style props into `props.vars`
 * (only the values that differ from the defaults' own output). */
export function namedStyleVars(
	props: Record<string, unknown>,
): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const [prop, writer] of Object.entries(VAR_WRITERS)) {
		if (writer === null) continue;
		vars[VAR_NAMES[prop]] = writer(props);
	}
	return vars;
}

/** The dynamic half of the document: everything the config carries.
 * Emission order is fixed (insertion order is the cache key order) and
 * every entry is filtered through `meta.uses`, so two inputs that differ
 * only in unused props produce the identical config. */
export interface TemplateConfig {
	vars?: Record<string, string>;
	text?: Record<string, string>;
	assets?: Record<string, string>;
	countdown?: { targetIso: string };
}

export interface TemplateDocInput {
	meta: TemplateMeta;
	/** Normalized element props (the schema's normalizeProps output). */
	props: Record<string, unknown>;
	/** title/subtitle with `{token}` interpolation already applied
	 * (templateText, shared with the alert element); doc.ts never resolves
	 * tokens itself, so it stays free of ElementContext/browser types. */
	text?: Record<string, string>;
	/** Resolved asset-library URL(s), absolute (the page's ctx.assetUrls). */
	assets?: { logo?: string };
}

export function buildTemplateConfig(input: TemplateDocInput): TemplateConfig {
	const { meta, props, text, assets } = input;
	const uses = new Set<string>(meta.uses);

	const vars: Record<string, string> = {};
	for (const [prop, writer] of Object.entries(VAR_WRITERS)) {
		if (!uses.has(prop) || writer === null) continue;
		vars[VAR_NAMES[prop]] = writer(props);
	}

	// `vars`: the template's `:root` custom properties as overridden by the
	// element (the inspector offers one field per `:root` entry). Gated like
	// every other entry — a template without "vars" in `uses` cannot change
	// when the record is edited. Keys arrive sorted (normalizeProps), which
	// keeps the doc-cache key stable for the same values.
	if (uses.has("vars")) {
		const user = props.vars;
		if (user !== null && typeof user === "object" && !Array.isArray(user))
			for (const [name, value] of Object.entries(
				user as Record<string, unknown>,
			))
				if (typeof value === "string" && value !== "") vars[name] = value;
	}

	const outText: Record<string, string> = {};
	for (const key of TEXT_PARAMS)
		if (uses.has(key) && typeof text?.[key] === "string")
			outText[key] = text[key];

	const outAssets: Record<string, string> = {};
	if (
		uses.has("logoAssetId") &&
		typeof assets?.logo === "string" &&
		assets.logo
	)
		outAssets.logo = assets.logo;

	const wantsCountdown =
		props.mode === "countdown" &&
		// uses-gated like every other entry: a template that does not
		// consume mode/targetIso must not change when those props are edited
		(uses.has("mode") || uses.has("targetIso"));
	return {
		...(Object.keys(vars).length > 0 ? { vars } : {}),
		...(Object.keys(outText).length > 0 ? { text: outText } : {}),
		...(Object.keys(outAssets).length > 0 ? { assets: outAssets } : {}),
		...(wantsCountdown && typeof props.targetIso === "string"
			? { countdown: { targetIso: props.targetIso } }
			: {}),
	};
}

// ── defensive prop readers (props arrive normalized; these are belt) ──

function str(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** #rrggbb (the props are schema-normalized; a non-hex falls back to
 * black so a var can never be invalid). */
function hex(v: unknown, fallback = "#000000"): string {
	return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)
		? v.toLowerCase()
		: fallback;
}

function hexChannels(v: string): [number, number, number] {
	const h = v.startsWith("#") ? v.slice(1) : v;
	return [
		parseInt(h.slice(0, 2), 16),
		parseInt(h.slice(2, 4), 16),
		parseInt(h.slice(4, 6), 16),
	];
}
