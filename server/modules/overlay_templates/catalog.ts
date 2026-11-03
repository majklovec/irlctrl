/*
 * The template document catalog (browser half) — read on the fly, not
 * precompiled.
 *
 * Each template is ONE self-contained HTML document
 * (`public/overlay_templates/<id>/index.html`): metadata meta tags
 * (`overlay-template:name` / `overlay-template:uses`), its `<style>`, and its
 * `<section>` body. The documents are served by the control server's
 * `/overlay_templates/*` static route (see server/backend/static_routes.ts),
 * whose `_catalog.json` route auto-discovers the ids by enumerating the
 * folders — there is no index file to maintain; dropping a new
 * `<id>/index.html` folder is the whole act of adding a template. The
 * runtime page fetches a template's file at load time and parses it
 * (template_doc.ts) — no bundler text imports — so editing a template on
 * disk takes effect on the next page load, no rebuild.
 *
 * Both fetchers take an optional `fetchText` (defaults to
 * `globalThis.fetch`) so tests can resolve the bytes from disk without a
 * live server. Caching is the caller's job: element.tsx memoizes per
 * template id so a runtime page with many elements — or a redraw that
 * re-runs `oncreate` — fetches each template once.
 *
 * `templates/template_meta.ts` is the environment-free metadata (importable
 * by overlay_schema.ts); this file is what only the browser may import.
 */

import {
	type ParsedTemplateDoc,
	parseTemplateDoc,
} from "./templates/template_doc";
import type { TemplateMeta } from "./templates/template_meta";

type FetchText = (url: string) => Promise<string>;

const DEFAULT_FETCH: FetchText = (url) => fetch(url).then((r) => r.text());

/** The URL of one template's document, relative to the control server. */
export function templateDocUrl(templateId: string): string {
	return `/overlay_templates/${templateId}/index.html`;
}

/**
 * Fetch + parse one template's self-contained document. Throws the parser's
 * descriptive Error on a broken document (script tag, missing parts,
 * vocabulary breach).
 */
export async function loadTemplateDoc(
	templateId: string,
	fetchText?: FetchText,
): Promise<ParsedTemplateDoc> {
	const text = await (fetchText ?? DEFAULT_FETCH)(templateDocUrl(templateId));
	return parseTemplateDoc(templateId, text);
}

/**
 * The runtime catalog: the ids from the server's auto-discovered
 * `/overlay_templates/_catalog.json`, each one's document fetched + parsed.
 * The edit form's template picker offers its `meta` list. Caching is the
 * caller's job.
 */
export async function loadTemplateCatalog(
	fetchText?: FetchText,
): Promise<TemplateMeta[]> {
	const fetcher = fetchText ?? DEFAULT_FETCH;
	const rawIds = JSON.parse(await fetcher("/overlay_templates/_catalog.json"));
	if (!Array.isArray(rawIds) || rawIds.some((x) => typeof x !== "string"))
		throw new Error("template catalog: _catalog.json must be a string array");
	const docs = await Promise.all(
		rawIds.map((id: string) =>
			fetcher(templateDocUrl(id)).then((text) => parseTemplateDoc(id, text)),
		),
	);
	return docs.map((d) => d.meta);
}
