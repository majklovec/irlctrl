/*
 * Lightweight HTML/CSS syntax highlighter for the template editor's code
 * pane. PURE by contract (same as preview.ts): a source string in, an
 * escaped HTML string of `tk-*` spans out — no DOM, no dependencies.
 *
 * It targets the template document contract (<meta>, <style>, <section>,
 * data-bind attributes), not full HTML: tags, attributes, quoted values,
 * comments, doctype, and the CSS inside <style> (custom properties,
 * selectors, values). Everything is escaped, so the output is safe to
 * inject into the highlighted <pre> under the editor's textarea.
 */

import { escapeHtml } from "./preview";

const span = (cls: string, s: string): string =>
	`<span class="${cls}">${escapeHtml(s)}</span>`;
const pun = (s: string): string => span("tk-pun", s);

/** A tag's body (no angle brackets): the name + its attributes. */
function highlightTagInner(inner: string): string {
	const name = inner.match(/^[a-zA-Z][a-zA-Z0-9-]*/)?.[0] ?? "";
	let out = span("tk-tag", name);
	const rest = inner.slice(name.length);

	const ATTR_RE =
		/([a-zA-Z_:][a-zA-Z0-9_:.-]*)(\s*=\s*)("(?:[^"]*)"|'(?:[^']*)'|[^\s"'>]+)/g;
	let last = 0;
	for (;;) {
		const m = ATTR_RE.exec(rest);
		if (!m) break;
		out += escapeHtml(rest.slice(last, m.index));
		out += span("tk-attr", m[1]) + pun("=") + span("tk-str", m[3]);
		last = m.index + m[0].length;
	}
	out += escapeHtml(rest.slice(last));
	return out;
}

/** CSS (the <style> content): comments, strings, at-rules; brace depth
 * decides property/value (inside a block) vs selector (outside). */
export function highlightCss(css: string): string {
	let out = "";
	let depth = 0;
	let i = 0;
	while (i < css.length) {
		const rest = css.slice(i);
		const match = (re: RegExp): RegExpExecArray | null => re.exec(rest);

		const mCmt = match(/^\/\*[\s\S]*?\*\//);
		if (mCmt) {
			out += span("tk-cmt", mCmt[0]);
			i += mCmt[0].length;
			continue;
		}
		const mStr = match(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
		if (mStr) {
			out += span("tk-str", mStr[0]);
			i += mStr[0].length;
			continue;
		}
		const ch = css[i];
		if (ch === "{") {
			depth++;
			out += pun("{");
			i++;
			continue;
		}
		if (ch === "}") {
			depth = Math.max(0, depth - 1);
			out += pun("}");
			i++;
			continue;
		}
		if ("();,".includes(ch)) {
			out += pun(ch);
			i++;
			continue;
		}
		const mAt = match(/^@[\w-]+/);
		if (mAt) {
			out += span("tk-at", mAt[0]);
			i += mAt[0].length;
			continue;
		}
		if (depth > 0) {
			const mProp = match(/^[\w-]+(?=\s*:)/);
			if (mProp) {
				out += span("tk-prop", mProp[0]);
				i += mProp[0].length;
				continue;
			}
		}
		const mColon = match(/^:[\w-]+/);
		if (mColon) {
			out += span(depth > 0 ? "tk-val" : "tk-sel", mColon[0]);
			i += mColon[0].length;
			continue;
		}
		const mNum = match(/^-?\d[\d.%a-fA-F]*/);
		if (mNum) {
			out += span("tk-val", mNum[0]);
			i += mNum[0].length;
			continue;
		}
		const mWord = match(/^[\w.#*&>~+=[\]"'-]+/);
		if (mWord) {
			out += span(depth > 0 ? "tk-val" : "tk-sel", mWord[0]);
			i += mWord[0].length;
			continue;
		}
		out += escapeHtml(ch);
		i++;
	}
	return out;
}

/** The <style> content start/end offsets in the source. */
function styleContentRanges(src: string): [number, number][] {
	const ranges: [number, number][] = [];
	for (const m of src.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)) {
		const openLen = m[0].indexOf(">") + 1;
		const base = m.index ?? 0;
		const start = base + openLen;
		const end = base + m[0].length - "</style>".length;
		if (end > start) ranges.push([start, end]);
	}
	return ranges;
}

/** The whole document: HTML tokens, with <style> content sub-highlighted
 * as CSS. The trailing newline keeps the last line's height in the <pre>. */
export function highlightHtml(src: string): string {
	if (src === "") return "";
	const ranges = styleContentRanges(src);
	const inStyle = (start: number, end: number): boolean =>
		ranges.some(([rs, re]) => rs <= start && end <= re);

	const out: string[] = [];
	// The trailing `|<|>` catches a lone angle bracket that forms no token
	// (e.g. stray `<` in text) so it is escaped + preserved, never dropped —
	// dropping a char would desync the highlight from the textarea.
	const TOKEN = /(<!--[\s\S]*?-->)|(<![^>]*>)|(<\/?[a-zA-Z][^<>]*>)|([^<>]+|<|>)/g;
	for (;;) {
		const m = TOKEN.exec(src);
		if (!m) break;
		if (m[1] !== undefined) {
			out.push(span("tk-cmt", m[1]));
		} else if (m[2] !== undefined) {
			out.push(span("tk-at", m[2]));
		} else if (m[3] !== undefined) {
			const tag = m[3];
			const closed = tag.startsWith("</");
			const selfClose = tag.endsWith("/>");
			const inner = tag.slice(closed ? 2 : 1, selfClose ? -2 : -1);
			out.push(
				pun(closed ? "</" : "<") +
					highlightTagInner(inner) +
					pun(closed ? ">" : selfClose ? "/>" : ">"),
			);
		} else {
			const start = m.index ?? 0;
			out.push(
				inStyle(start, start + m[0].length)
					? highlightCss(m[0])
					: escapeHtml(m[0]),
			);
		}
	}
	return out.join("") + "\n";
}
