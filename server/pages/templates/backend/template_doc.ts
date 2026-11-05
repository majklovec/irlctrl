/*
 * The template document parser for the templates page: one self-contained
 * HTML document per template (assets/overlay_templates/<id>.html) carrying
 *   - `<meta name="name">`  — the i18n name key,
 *   - one `<style>` block  — the template's CSS,
 *   - one `<section>`      — the document body.
 *
 * The overlays runtime parses the same documents (see
 * server/pages/overlays/modules/overlay_templates/templates/template_doc.ts);
 * page slices may never import each other (test/pages_boundaries.test.ts),
 * so the templates page carries its own mirror of the contract.
 *
 * Two entry points:
 *   - parseTemplateDoc — STRICT (create/save): throws on any contract breach,
 *     so a write can never leave a document the runtime cannot render.
 *   - describeTemplateDoc — LENIENT (list/open): never throws; a broken file
 *     comes back `valid: false` with its error, so the editor can open it
 *     and the author can fix it.
 *
 * PURE by contract (no fs, no DOM): the browser preview reuses the same
 * parsing rules (the frontend keeps its own copy in frontend/preview.ts).
 */

/** One declared `:root` custom property: `--name` + its fallback value. */
export type RootVar = [name: string, value: string];

/** A parsed template document. */
export interface TemplateDoc {
	/** True when the document met the whole contract. */
	valid: boolean;
	/** The `<meta name="name">` i18n key ("" when unparsable). */
	name: string;
	/** The single `<style>` block's content ("" when unparsable). */
	css: string;
	/** The single `<section>` (the body; "" when unparsable). */
	body: string;
	/** The template's ordered `:root` custom properties. */
	vars: RootVar[];
	/** The template's `data-bind` slot names (first-seen, deduplicated). */
	binds: string[];
	/** The contract breach (when `valid` is false). */
	error?: string;
}

/** Template ids are file slugs: lowercase letters, digits, underscores. */
export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9_]*$/;

const NAME_META_RE = /<meta\s+name="name"\s+content="([^"]*)"\s*\/?>/;
const STYLE_RE = /<style>([\s\S]*?)<\/style>/;
const SECTION_RE = /<section\b[\s\S]*?<\/section>/g;
const BIND_RE = /\bdata-bind="([^"]+)"/g;
const ROOT_RE = /:root\s*\{([\s\S]*?)\}/;
const VAR_NAME_RE = /^--[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** Parse one template's CSS `:root` block into ordered [name, value] pairs.
 * Comments are stripped first; a malformed entry is skipped. */
export function parseRootVars(css: string): RootVar[] {
	const block = ROOT_RE.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1];
	if (block === undefined) return [];
	const out: RootVar[] = [];
	for (const part of block.split(";")) {
		const idx = part.indexOf(":");
		if (idx < 0) continue;
		const name = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (VAR_NAME_RE.test(name) && value !== "") out.push([name, value]);
	}
	return out;
}

/** The `data-bind` slot names in a body (first-seen order, deduplicated). */
export function parseBinds(body: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of body.matchAll(BIND_RE)) {
		if (!seen.has(m[1])) {
			seen.add(m[1]);
			out.push(m[1]);
		}
	}
	return out;
}

/**
 * The strict parse (create/save gate): throws a descriptive Error on a
 * contract breach (script tag, missing/duplicated parts, empty meta).
 */
export function parseTemplateDoc(_id: string, rawHtml: string): void {
	if (/<script[\s>]/i.test(rawHtml))
		throw new Error("the document contains a <script> tag");
	const meta = NAME_META_RE.exec(rawHtml);
	if (!meta) throw new Error('the document is missing <meta name="name">');
	if (meta[1].trim() === "") throw new Error("the name meta is empty");
	if (!STYLE_RE.test(rawHtml))
		throw new Error("the document is missing a <style> block");
	const sections = [...rawHtml.matchAll(SECTION_RE)];
	if (sections.length !== 1)
		throw new Error(
			`the document must contain exactly one <section> (found ${sections.length})`,
		);
}

/**
 * The lenient parse (list/open): never throws. A broken document comes back
 * `valid: false` with the first breach as `error`; the fields it does expose
 * (vars, binds, name) are best-effort, so the editor can show what is
 * salvageable and the author can fix the file.
 */
export function describeTemplateDoc(_id: string, rawHtml: string): TemplateDoc {
	let valid = true;
	let error: string | undefined;
	const breach = (what: string): void => {
		if (valid) {
			valid = false;
			error = what;
		}
	};

	if (/<script[\s>]/i.test(rawHtml))
		breach("the document contains a <script> tag");
	const meta = NAME_META_RE.exec(rawHtml);
	if (!meta || meta[1].trim() === "")
		breach('the document is missing a non-empty <meta name="name">');
	const css = STYLE_RE.exec(rawHtml)?.[1]?.trim() ?? "";
	if (css === "") breach("the document is missing a <style> block");
	const sections = [...rawHtml.matchAll(SECTION_RE)];
	if (sections.length !== 1)
		breach(
			`the document must contain exactly one <section> (found ${sections.length})`,
		);
	const body = sections[0]?.[0] ?? "";

	return {
		valid,
		name: meta?.[1].trim() ?? "",
		css,
		body,
		vars: parseRootVars(css),
		binds: parseBinds(body),
		...(error !== undefined ? { error } : {}),
	};
}
