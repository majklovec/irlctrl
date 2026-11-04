/*
 * Schema of the `html_template` overlay element: a first-party HTML/CSS
 * template rendered in an `<iframe srcdoc>` (the browser half is
 * overlay_elements.tsx; the document builder is doc.ts).
 *
 * Environment-free on purpose: the control server's scene validator and the
 * browser editor both import this file, so it never touches HTML, CSS,
 * mithril or the template folders — the template id is validated as a
 * folder SLUG (the catalog itself — the server's auto-discovered
 * `/overlay_templates/_catalog.json` — is fetched at runtime; modules may
 * not import `public/`, so no frozen id vocabulary is carried here).
 *
 * The prop vocabulary is FROZEN (no per-template free-form params): bindings
 * are one level deep (`resolveElement` does `props.<field> = value`), so new
 * visual knobs = extend DEFAULT_HTML_TEMPLATE_PROPS + normalizeProps + the
 * doc builder's var/text/asset map + TemplateParam + README (not a record).
 */

import type { OverlayElementSchema } from "../../../../core/overlay_element";
import { namedStyleVars } from "./doc";

export interface HtmlTemplateProps {
	/** File id under `assets/overlay_templates` (one self-contained
	 * `<id>.html` per template; the server auto-discovers the ids from the
	 * files). */
	templateId: string;
	/** `{token}`-templated, rendered via textContent (never innerHTML). */
	title: string;
	subtitle: string;
	/** `#rrggbb` — the hex reader has no alpha channel, hence bgAlpha. */
	accentColor: string;
	bgColor: string;
	/** 0–100 percent opacity of the background. */
	bgAlpha: number;
	textColor: string;
	fontFamily: string;
	/** 6–400 px. */
	fontSize: number;
	/** 0–500 px. */
	radius: number;
	/** 0–200 px. */
	padding: number;
	/** The template's `:root` custom properties as overridden by this
	 * element, keyed by variable name (`"--accent": "#ff0000"`). Empty =
	 * the template's `:root` fallbacks apply. The inspector offers one
	 * field per `:root` entry (parseRootVars); a template consumes them
	 * through `"vars"` in its `uses` list. The named style props above are
	 * the legacy carriers of the same values — non-default ones are folded
	 * into `vars` at normalization (see normalizeProps). */
	vars: Record<string, string>;
	/** Asset-library file id of the logo ("" = none). */
	logoAssetId: string;
	/** "countdown" shows targetIso as a ticking H:MM:SS. */
	mode: "static" | "countdown";
	/** ISO 8601; validated (not coerced) so a bad value stays visible. */
	targetIso: string;
}

export const DEFAULT_HTML_TEMPLATE_PROPS: Required<HtmlTemplateProps> = {
	templateId: "lower_third_bar",
	title: "",
	subtitle: "",
	accentColor: "#6c5ce7",
	bgColor: "#0f0f19",
	bgAlpha: 92,
	textColor: "#ffffff",
	fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
	fontSize: 32,
	radius: 12,
	padding: 24,
	vars: {},
	logoAssetId: "",
	mode: "static",
	targetIso: "",
};

/** The named style writers' output for the defaults — the baseline the
 * legacy migration compares against (only NON-default values are folded
 * into `vars`, so fresh elements stay at the template's `:root` fallbacks
 * and keep lean props/docs). */
const NAMED_STYLE_BASE = namedStyleVars(DEFAULT_HTML_TEMPLATE_PROPS);

export const htmlTemplateSchema: OverlayElementSchema = {
	type: "html_template",
	defaultProps: DEFAULT_HTML_TEMPLATE_PROPS,
	serverAssetProps: ["logoAssetId"],
	normalizeProps(props, read) {
		const d = DEFAULT_HTML_TEMPLATE_PROPS;
		let vars = readVars(props.vars);
		const normalized: Record<string, unknown> = {
			templateId: readTemplateId(props.templateId, d.templateId),
			title: read.str("title", d.title, 500),
			subtitle: read.str("subtitle", d.subtitle, 500),
			accentColor: read.hex("accentColor", d.accentColor),
			bgColor: read.hex("bgColor", d.bgColor),
			bgAlpha: read.num("bgAlpha", d.bgAlpha, 0, 100),
			textColor: read.hex("textColor", d.textColor),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
			fontSize: read.num("fontSize", d.fontSize, 6, 400),
			radius: read.num("radius", d.radius, 0, 500),
			padding: read.num("padding", d.padding, 0, 200),
			vars,
			logoAssetId: read.str("logoAssetId", d.logoAssetId, 200),
			mode: read.oneOf("mode", ["static", "countdown"] as const, d.mode),
			// kept as a plain string on purpose: a malformed ISO value must
			// survive to validate() so the inspector can show it, not be
			// silently reset here.
			targetIso: read.str("targetIso", d.targetIso, 64),
		};
		// Legacy migration: scenes saved before `vars` carried the style
		// knobs as named props (accentColor, bgColor+bgAlpha, …). When the
		// element has no explicit `vars`, fold the NON-default named values
		// into it so an old scene keeps its look; fresh elements (defaults
		// everywhere) stay at the template's `:root` fallbacks. Idempotent:
		// once `vars` is non-empty the fold never runs again.
		if (Object.keys(vars).length === 0) {
			const legacy = namedStyleVars(normalized);
			const folded: Record<string, string> = {};
			for (const [name, value] of Object.entries(legacy))
				if (NAMED_STYLE_BASE[name] !== value) folded[name] = value;
			vars = sortedVars(folded);
			normalized.vars = vars;
		}
		return normalized;
	},
};

/** The template id is a file slug under `assets/overlay_templates`
 * (the server's runtime `_catalog.json` route enumerates the live ones by
 * listing the `*.html` files). Only the shape is validated here — a missing
 * file 404s at render time and the element's validator flags it — because
 * modules may not import `public/`, so a frozen id vocabulary would have to
 * be kept in sync by hand. */
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9_]*$/;
function readTemplateId(raw: unknown, fallback: string): string {
	if (
		typeof raw === "string" &&
		raw.length > 0 &&
		raw.length <= 64 &&
		TEMPLATE_ID_RE.test(raw)
	)
		return raw;
	return fallback;
}

/** Rebuild a vars record with sorted keys (the record is part of the
 * doc-cache key, so the order must be stable across loads). */
function sortedVars(rec: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : 1)),
	);
}

/** Sanitize a stored `vars` record: `--name`-shaped keys, short string
 * values, capped entry count, sorted keys. */
function readVars(raw: unknown): Record<string, string> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (Object.keys(out).length >= 32) break;
		if (!/^--[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(key)) continue;
		if (typeof value !== "string" || value === "" || value.length > 200)
			continue;
		out[key] = value;
	}
	return sortedVars(out);
}

export default [htmlTemplateSchema];
