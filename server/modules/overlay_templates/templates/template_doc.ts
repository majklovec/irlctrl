/**
 * parseTemplateDoc — parse one overlay template's self-contained HTML
 * document into its parts.
 *
 * A template is ONE browser-viewable HTML file
 * (`public/overlay_templates/<id>/index.html`) carrying:
 *   - `<meta name="overlay-template:name">`  — the i18n name key,
 *   - one `<style>` block — the template's CSS,
 *   - one `<section>` — the document body, whose hooks (`data-bind`,
 *     `data-asset="logo"`, `data-countdown`) + the `<style>`'s `:root`
 *     vars DECLARE which params the template consumes (`uses` is derived
 *     from them, not hand-listed — see deriveUses).
 *
 * No `<script>` is allowed: the doc is inert markup + style, rendered
 * server-side (render_doc.ts). Pure — no DOM, no Bun, testable anywhere.
 */

import { parseRootVars } from "./root_vars";
import { type TemplateMeta, type TemplateParam } from "./template_meta";

/** A parsed template document. */
export interface ParsedTemplateDoc {
	/** The metadata: the folder id + the two meta tags. */
	meta: TemplateMeta;
	/** The single `<style>` block's content. */
	css: string;
	/** The single `<section>` (the body). */
	body: string;
}

function readMetaTag(rawHtml: string, name: string, id: string): string {
	const re = new RegExp(
		`<meta\\s+name="overlay-template:${name}"\\s+content="([^"]*)"\\s*/?>`,
	);
	const found = re.exec(rawHtml);
	if (!found) {
		throw new Error(
			`template ${id} document missing <meta name="overlay-template:${name}">`,
		);
	}
	const value = found[1].trim();
	if (!value) {
		throw new Error(
			`template ${id} document has an empty overlay-template:${name} meta`,
		);
	}
	return value;
}

/** Parse one template's HTML document; throws a descriptive Error on a
 * broken structure (script tag, missing/duplicated parts, vocabulary
 * breach). */
export function parseTemplateDoc(
	id: string,
	rawHtml: string,
): ParsedTemplateDoc {
	// The doc must be inert — no script of any kind.
	if (/<script[\s>]/i.test(rawHtml)) {
		throw new Error(`template ${id} document contains a <script> tag`);
	}

	const name = readMetaTag(rawHtml, "name", id);

	const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(rawHtml);
	if (!styleMatch) {
		throw new Error(`template ${id} document missing a <style> block`);
	}
	const css = styleMatch[1].trim();

	const sections = [...rawHtml.matchAll(/<section\b[\s\S]*?<\/section>/g)];
	if (sections.length !== 1) {
		throw new Error(
			`template ${id} document must contain exactly one <section> (found ${sections.length})`,
		);
	}
	const body = sections[0][0];

	const meta: TemplateMeta = { id, name, uses: deriveUses(css, body) };
	return { meta, css, body };
}

/**
 * Derive the params a template consumes from the document ITSELF — no
 * hand-maintained list, so a hook added to the markup is picked up
 * automatically:
 *   - `data-bind="title"` / `data-bind="subtitle"` in the body → the bound
 *     text params,
 *   - a non-empty `:root` block → `vars` (the inspector's knobs),
 *   - `data-asset="logo"` in the body → `logoAssetId`,
 *   - a `data-countdown` hook in the body → `mode` + `targetIso`.
 *
 * Emission order is fixed (title, subtitle, vars, logoAssetId, mode,
 * targetIso) and is the edit-form field order + the doc-cache key order.
 */
function deriveUses(css: string, body: string): TemplateParam[] {
	const uses: TemplateParam[] = [];
	if (/\bdata-bind="title"/.test(body)) uses.push("title");
	if (/\bdata-bind="subtitle"/.test(body)) uses.push("subtitle");
	if (parseRootVars(css).length > 0) uses.push("vars");
	if (/\bdata-asset="logo"/.test(body)) uses.push("logoAssetId");
	if (/\bdata-countdown\b/.test(body)) {
		uses.push("mode");
		uses.push("targetIso");
	}
	return uses;
}
