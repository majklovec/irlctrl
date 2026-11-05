/*
 * The template editor's HTML/CSS highlighter (frontend/highlight.ts).
 * It is PURE — a source string in, an escaped `tk-*` span string out — so the
 * tests assert directly on the shape of the output: which token classes wrap
 * which text, and that every raw `<`, `>`, `&` in the input is escaped so the
 * result is safe to inject under the editor's textarea via m.trust().
 */
import { describe, expect, test } from "bun:test";
import {
	highlightCss,
	highlightHtml,
} from "../server/pages/templates/frontend/highlight";

/** Strip the `tk-*` spans and decode entities back to the source text (the
 * full inverse of the highlighter) — used to prove the transform is lossless. */
function unspans(html: string): string {
	return html
		.replace(/<span class="tk-[^"]+">/g, "")
		.replace(/<\/span>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

describe("highlightHtml", () => {
	test("empty input yields an empty string", () => {
		expect(highlightHtml("")).toBe("");
	});

	test("escapes a bare < and & in text nodes", () => {
		const out = highlightHtml("a < b & c");
		// No raw angle bracket / ampersand leaks out of a text node.
		expect(out).not.toMatch(/(?<!&lt)&(?![a-z#])/);
		expect(out).toContain("a &lt; b &amp; c");
	});

	test("highlights a tag, its attributes and its quoted value", () => {
		const out = highlightHtml(`<div class="a b" data-x='y' />`);
		expect(out).toContain(`<span class="tk-tag">div</span>`);
		expect(out).toContain(`<span class="tk-attr">class</span>`);
		expect(out).toContain(`<span class="tk-attr">data-x</span>`);
		// The quoted values are wrapped as strings.
		expect(out).toMatch(/<span class="tk-str">"a b"<\/span>/);
		expect(out).toMatch(/<span class="tk-str">'y'<\/span>/);
		// Angle brackets/punctuation land in tk-pun.
		expect(out).toContain(`<span class="tk-pun">`);
	});

	test("the unspans round-trips back to the source text", () => {
		const src = `<div class="x">a &amp; b</div>`;
		// A single trailing \n is appended so the <pre> renders the last line's
		// height (a <pre> collapses a trailing newline, so the caret line needs it).
		expect(unspans(highlightHtml(src))).toBe(src + "\n");
	});

	test("self-closing tags keep the /> as punctuation", () => {
		const out = highlightHtml(`<img src="a.png" alt="x">`);
		expect(out).toContain(`<span class="tk-tag">img</span>`);
		// A closing tag reuses tk-tag for the name.
		const close = highlightHtml(`</section>`);
		expect(close).toContain(`<span class="tk-tag">section</span>`);
		expect(close).toContain(`<span class="tk-pun">&lt;/`);
	});

	test("the doctype is a single tk-at token", () => {
		const out = highlightHtml(`<!DOCTYPE html>`);
		// Content is escaped (a `<!...>` must never survive as markup).
		expect(out).toContain(`<span class="tk-at">&lt;!DOCTYPE html&gt;</span>`);
	});

	test("comments are tk-cmt", () => {
		const out = highlightHtml(`<!-- hi --><div></div>`);
		expect(out).toContain(`<span class="tk-cmt">&lt;!-- hi --&gt;</span>`);
	});
});

describe("highlightHtml: <style> sub-highlighting", () => {
	test("CSS inside <style> is tokenised, not treated as markup", () => {
		const src = `<style>:root { --accent: #3b82f6; }</style>`;
		const out = highlightHtml(src);
		// The <style>/<\/style> tags are tk-tag.
		expect(out).toContain(`<span class="tk-tag">style</span>`);
		// The custom property name is a CSS property token.
		expect(out).toContain(`<span class="tk-prop">--accent</span>`);
		// The hex value is a CSS value token.
		expect(out).toContain(`<span class="tk-val">#3b82f6</span>`);
		// The selector :root is a selector token.
		expect(out).toContain(`<span class="tk-sel">:root</span>`);
	});

	test("text outside <style> is NOT CSS-highlighted", () => {
		// A literal `--` in a text node must not become a tk-prop.
		const out = highlightHtml(`--accent`);
		expect(out).not.toContain(`tk-prop`);
	});
});

describe("highlightCss", () => {
	test("properties vs selectors is decided by brace depth", () => {
		const out = highlightCss(`.box a { color: red; }`);
		expect(out).toContain(`<span class="tk-sel">.box</span>`);
		expect(out).toContain(`<span class="tk-prop">color</span>`);
		expect(out).toContain(`<span class="tk-val">red</span>`);
	});

	test("comments and strings are their own tokens", () => {
		const out = highlightCss(`/* note */ x { content: "q"; }`);
		expect(out).toContain(`<span class="tk-cmt">/* note */`);
		expect(out).toContain(`<span class="tk-str">"q"</span>`);
	});

	test("at-rules are tk-at", () => {
		expect(highlightCss(`@media (min-width: 600px) {}`)).toContain(
			`<span class="tk-at">@media</span>`,
		);
	});

	test("unbalanced closing braces clamp depth at zero", () => {
		// Must not throw and must stay sane.
		expect(highlightCss(`} } a { b: c; }`)).toContain(`tk-prop`);
	});
});

describe("escaping safety", () => {
	test("a <script>-like payload is fully neutralised", () => {
		const out = highlightHtml(`<div><script>alert(1)</script></div>`);
		// The script content is escaped text; a raw <script> element must not survive.
		expect(out).not.toContain(`><script>`);
		// Every < and > is escaped except the ones we deliberately wrap in spans.
		const bare = out.replace(/<\/?span[^>]*>/g, "");
		expect(bare).not.toMatch(/</);
		expect(bare).not.toMatch(/>/);
	});
});
