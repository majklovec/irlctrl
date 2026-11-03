/*
 * The doc renderer: turns one template (bundled markup + a resolved config)
 * into the in-page HTML string an element renders via `m.trust`.
 *
 * PURE by contract (no DOM, no Mithril): the same string must come out of
 * the bun test and the browser. The string is built from FIRST-PARTY parts
 * (the template markup, the wrapper) plus DYNAMIC values that are only
 * ever entity-escaped (escapeHtml/escapeAttr) — user text can never break
 * out of its text node or attribute, and the output never contains a
 * `<script>` (the in-frame bootstrap script is gone: vars ride the
 * wrapper's style attribute, text/assets are baked in, the countdown is a
 * page-level tick — see element.tsx).
 *
 * A changed config ⇒ a changed string ⇒ mithril rewrites the subtree
 * (innerHTML semantics). An identical string ⇒ mithril's string diff
 * leaves the DOM untouched, so CSS animations keep running.
 */

import type { TemplateConfig } from "../doc";
import type { TemplateMeta } from "./template_meta";

interface RenderInput {
	meta: TemplateMeta;
	/** The template body — the parsed `<section>` (template_doc.ts). */
	body: string;
	/** The resolved config (buildTemplateConfig output — uses-gated). */
	config: TemplateConfig;
}

/** Entity-escape for a TEXT node: & first, then < >. */
export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Entity-escape for a DOUBLE-QUOTED attribute value. */
export function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/"/g, "&quot;");
}

/** The template's body markup: a bare fragment (no doc wrapper — the
 * parser, template_doc.ts, already stripped it). A `<script>` anywhere is
 * a contract breach (the parser rejects it too — this is the render-side
 * guard). */
export function templateBody(body: string): string {
	if (/<script[\s>]/i.test(body))
		throw new Error("render_doc: template body must not contain <script>");
	return body.trim();
}

/** Bake one `data-bind="key"` slot's text into the markup (escaped). The
 * tag may carry attributes in any order; the slot is the first element
 * carrying the attribute. An unmatched key is a contract breach: the
 * config only carries keys the template uses, so the slot must exist. */
function bindSlot(body: string, key: string, value: string): string {
	const re = new RegExp(
		`(<[a-zA-Z][a-zA-Z0-9]*\\b[^>]*?\\bdata-bind="${key}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`,
	);
	if (!re.test(body))
		throw new Error(`render_doc: no data-bind="${key}" slot in template`);
	// attribute order doesn't matter, so match the tag generically
	return body.replace(
		new RegExp(
			`(\\bdata-bind="${key}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`,
		),
		`$1${escapeHtml(value)}$3`,
	);
}

/** Bake one `data-asset="key"` slot's URL into its `src` attribute
 * (works for void elements like `<img>` and for tags with children). */
function assetSlot(body: string, key: string, url: string): string {
	const re = new RegExp(
		`(<[a-zA-Z][a-zA-Z0-9]*\\b[^>]*?\\bdata-asset="${key}"[^>]*?)/?>`,
	);
	if (!re.test(body))
		throw new Error(`render_doc: no data-asset="${key}" slot in template`);
	return body.replace(re, (tag: string) => {
		const selfClosed = tag.endsWith("/>");
		// strip just the closing bracket(s) so `src` lands inside the tag
		const open = selfClosed ? tag.slice(0, -2) : tag.slice(0, -1);
		const withSrc = /\bsrc="/.test(open)
			? open.replace(/\bsrc="[^"]*"/, `src="${escapeAttr(url)}"`)
			: `${open} src="${escapeAttr(url)}"`;
		return selfClosed ? `${withSrc}/>` : `${withSrc}>`;
	});
}

/** The per-template wrapper class (rendered by renderTemplateDoc,
 * scoper target in css_scope, style host) — one definition. */
export function templateWrapperClass(id: string): string {
	return `ov-tpl-${id}`;
}

/**
 * Render the element's in-page HTML. Output shape:
 *
 *   <div class="ov-tpl-<id>" style="--accent:…;…">
 *     …the template's body markup, slots baked in…
 *   </div>
 *
 * No `<style>` (injected once per template id by element.tsx via
 * css_scope), no `<script>`.
 */
export function renderTemplateDoc({ meta, body, config }: RenderInput): string {
	let out = templateBody(body);

	for (const [key, value] of Object.entries(config.text ?? {}))
		out = bindSlot(out, key, value);
	for (const [key, url] of Object.entries(config.assets ?? {}))
		out = assetSlot(out, key, url);

	const styleParts = Object.entries(config.vars ?? {}).map(
		([name, value]) => `${name}:${escapeAttr(value)}`,
	);

	return `<div class="ov-tpl-${meta.id}" style="${styleParts.join(";")}">${out}</div>`;
}
