/*
 * The browser-side preview builder: turns the editor's current document
 * (the template html + the CSS var and data-bind values) into a standalone
 * HTML document for the preview iframe.
 *
 * It mirrors the runtime contract (the server's parse in
 * backend/template_doc.ts and the overlays module's render in
 * render_doc.ts): the template's <style> + <section> render with the
 * variables overriding `:root` and every data-bind slot filled. The
 * documents are parsed with the same regexes on both sides, so what the
 * author previews is what the runtime bakes.
 *
 * PURE by contract (no DOM): testable and side-effect free.
 */

const STYLE_RE = /<style>([\s\S]*?)<\/style>/;
const SECTION_RE = /<section\b[\s\S]*?<\/section>/;
const SECTION_ALL_RE = /<section\b[\s\S]*?<\/section>/g;
const NAME_META_RE = /<meta\s+name="name"\s+content="([^"]*)"\s*\/?>/;
const BIND_RE = /\bdata-bind="([^"]+)"/g;
const ROOT_RE = /:root\s*\{([\s\S]*?)\}/;
const VAR_NAME_RE = /^--[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** Entity-escape for a TEXT node: & first, then < >. */
export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The text-node unescape (reading a slot's default back out of markup). */
export function unescapeHtml(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

/** Fill every `data-bind="<slot>"` element's content with `value` (escaped,
 * all occurrences — a template may bind one slot twice, e.g. the ticker's
 * marquee copies). */
export function fillBinds(body: string, slot: string, value: string): string {
	const re = new RegExp(
		`(\\bdata-bind="${slot}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`,
		"g",
	);
	return body.replace(re, `$1${escapeHtml(value)}$3`);
}

/** The first element carrying `data-bind="<slot>"`, its text decoded. */
export function defaultBind(body: string, slot: string): string {
	const re = new RegExp(`\\bdata-bind="${slot}"[^>]*>([\\s\\S]*?)<`);
	return unescapeHtml(re.exec(body)?.[1] ?? "");
}

export interface PreviewInput {
	/** The template's whole html document (the editor's textarea). */
	html: string;
	/** The CSS var values (name without `--` is NOT used; full `--name`). */
	vars: Record<string, string>;
	/** The data-bind slot texts. */
	text: Record<string, string>;
}

/**
 * Build the preview document. The variables ride the <html> inline style —
 * that outranks the template's own `:root {}` fallbacks without touching
 * the stylesheet, exactly like the runtime's per-element override style.
 * A document that cannot be parsed degrades to its raw text so the author
 * sees their content, not a blank frame.
 */
export function buildPreviewDoc({ html, vars, text }: PreviewInput): string {
	const style = STYLE_RE.exec(html)?.[1] ?? "";
	const section = SECTION_RE.exec(html)?.[0] ?? "";

	if (style === "" || section === "") {
		return `<html><body style="margin:0;padding:24px;font-family:monospace;color:#f87171">${escapeHtml(
			html,
		)}</body></html>`;
	}

	let body = section;
	for (const [slot, value] of Object.entries(text))
		body = fillBinds(body, slot, value);

	const varStyle = Object.entries(vars)
		.filter(([, value]) => value !== "")
		.map(([name, value]) => `${name}:${value}`)
		.join(";");

	// The preview frame fills the element's box: 100% x 100%, transparent.
	const frame =
		"html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}" +
		".tpl-frame{position:relative;width:100%;height:100%}";

	return `<!doctype html>
<html style="${varStyle}">
<head>
<meta charset="utf-8" />
<style>${frame}${style}</style>
</head>
<body>
<div class="tpl-frame">${body}</div>
</body>
</html>`;
}

/** The template's display-name i18n key ("" when the meta is missing). */
export function templateNameKey(html: string): string {
	return NAME_META_RE.exec(html)?.[1]?.trim() ?? "";
}

/** The template's `:root` custom properties (name + current value), in
 * document order — the mirror of the backend's parseRootVars. */
export function parseVars(html: string): [string, string][] {
	const block = ROOT_RE.exec(html)?.[1];
	if (block === undefined) return [];
	const out: [string, string][] = [];
	for (const part of block.split(";")) {
		const idx = part.indexOf(":");
		if (idx < 0) continue;
		const name = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (VAR_NAME_RE.test(name) && value !== "") out.push([name, value]);
	}
	return out;
}

/** The `data-bind` slot names (first-seen, deduplicated). */
export function parseBinds(html: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of html.matchAll(BIND_RE)) {
		if (!seen.has(m[1])) {
			seen.add(m[1]);
			out.push(m[1]);
		}
	}
	return out;
}

/**
 * The lenient contract check (the browser mirror of the backend's
 * describeTemplateDoc): the document's validity + the first breach. The
 * server re-validates on save — this is the editor's live indicator.
 */
export function describeDoc(html: string): { valid: boolean; error?: string } {
	if (/<script[\s>]/i.test(html))
		return { valid: false, error: "the document contains a <script> tag" };
	const meta = NAME_META_RE.exec(html);
	if (!meta || meta[1].trim() === "")
		return {
			valid: false,
			error: 'the document is missing a non-empty <meta name="name">',
		};
	if (!STYLE_RE.test(html))
		return { valid: false, error: "the document is missing a <style> block" };
	const sections = [...html.matchAll(SECTION_ALL_RE)];
	if (sections.length !== 1)
		return {
			valid: false,
			error: `the document must contain exactly one <section> (found ${sections.length})`,
		};
	return { valid: true };
}
