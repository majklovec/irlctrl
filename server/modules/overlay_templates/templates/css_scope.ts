/*
 * CSS scoper: rewrites a template's bundled stylesheet to a per-template
 * wrapper class so the same CSS can live in the shared editor/runtime
 * page (in an iframe the stylesheet is document-internal; in-page it
 * must be isolated, or its `:root` vars, the `*` box-sizing rule and the
 * generic class names would leak into the app).
 *
 * PURE on purpose (no DOM): unit-testable, and reusable by a future
 * server renderer. The supported selector set is deliberately small and
 * FAILS LOUDLY on anything it doesn't understand — a template that
 * breaks the contract must not render at all.
 */

/** Root selectors that mean "the template's own root" and collapse onto
 * the wrapper class in the shared document. */
const ROOT_SELECTORS: ReadonlySet<string> = new Set([":root", "html", "body"]);

/** Split a CSS text (comments already stripped) into top-level
 * `head { body }` statements. Bodies may nest (only `@media` does in this
 * contract); only depth-0 braces delimit statements. `loose` collects the
 * text between statements — it must be whitespace, or the stylesheet is
 * malformed (e.g. a bare `@import` rule, which carries no block). */
function splitTopLevel(css: string): {
	statements: string[];
	loose: string[];
} {
	const statements: string[] = [];
	const loose: string[] = [];
	let depth = 0;
	let start = 0;
	let lastEnd = 0;
	for (let i = 0; i < css.length; i++) {
		const ch = css[i];
		if (ch === "{") {
			if (depth === 0) start = lastEnd; // the selector starts after the previous statement
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				loose.push(css.slice(lastEnd, start)); // text before this rule's selector
				statements.push(css.slice(start, i + 1)); // `head { body }`
				lastEnd = i + 1;
			}
		}
	}
	if (depth !== 0) throw new Error("css_scope: unbalanced braces");
	loose.push(css.slice(lastEnd));
	return { statements, loose: loose.filter((l) => l.trim() !== "") };
}

function assertOnlyWhitespace(loose: string[], where: string): void {
	for (const l of loose)
		if (l.trim() !== "")
			throw new Error(`css_scope: non-rule text in ${where}: "${l.trim()}"`);
}

/** Scope one `head { body }` statement to `wrapper`. */
function scopeStatement(
	statement: string,
	wrapper: string,
	keyframes: Map<string, string>,
): string {
	const open = statement.indexOf("{");
	const head = statement.slice(0, open).trim();
	const body = statement.slice(open + 1, statement.lastIndexOf("}"));

	if (head.startsWith("@")) {
		// the at-keyword only — each branch validates its own tail (an
		// @keyframes carries a name, so a `(...)?`-only gate would reject it)
		const at = head.match(/^@(\w+)/);
		if (!at) throw new Error(`css_scope: bad at-rule "${head}"`);
		if (at[1] === "media") {
			// recurse over the NESTED blocks; keep the condition as-is
			const nested = splitTopLevel(body);
			assertOnlyWhitespace(nested.loose, `@media "${head}"`);
			const scoped = nested.statements
				.map((s) => scopeStatement(s, wrapper, keyframes))
				.join("\n");
			return `${head} {\n${scoped}\n}`;
		}
		if (at[1] === "keyframes") {
			const kf = head.match(/^@keyframes\s+([\w-]+)/);
			if (!kf) throw new Error(`css_scope: bad @keyframes "${head}"`);
			const renamed = `${kf[1]}__${wrapper.slice(1).replace(/[^a-zA-Z0-9-]/g, "")}`;
			keyframes.set(kf[1], renamed);
			return `${head.replace(kf[1], renamed)} {${body}}`;
		}
		// @import / @font-face / @supports / … — templates are
		// self-contained, so anything else is a contract breach
		throw new Error(`css_scope: unsupported at-rule @${at[1]}`);
	}

	// ordinary rule: scope every selector in the comma list
	const parts = head
		.split(",")
		.map((sel) => {
			const s = sel.trim();
			if (s === "") throw new Error(`css_scope: empty selector in "${head}"`);
			if (ROOT_SELECTORS.has(s)) return wrapper;
			if (s === "*" || s.startsWith("*::") || s.startsWith("*:"))
				return `${wrapper} ${s}`;
			if (/:root\b/.test(s) || /\b(html|body)\b/.test(s))
				throw new Error(
					`css_scope: html/body/:root only as standalone selectors ("${s}")`,
				);
			return `${wrapper} ${s}`;
		});
	// `:root, html, body` all collapse to the wrapper — de-duplicate.
	return [...new Set(parts)].join(", ") + ` {${body}}`;
}

/**
 * Scope a whole template stylesheet to `wrapper` (a class selector).
 * `@keyframes` names are renamed per wrapper and every `animation`
 * reference is patched to follow.
 * @throws on unbalanced braces, unknown at-rules, junk text, or root
 *   selectors used inside a compound selector — contract breaches fail
 *   loudly.
 */
export function scopeTemplateCss(css: string, wrapper: string): string {
	if (!wrapper.startsWith("."))
		throw new Error("css_scope: wrapper must be a class selector");
	const keyframes = new Map<string, string>();
	// CSS comments are insignificant — strip them so the authoring header
	// every template starts with (a `/* … */` block between rules) is not
	// flagged as loose text.
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const { statements, loose } = splitTopLevel(stripped);
	assertOnlyWhitespace(loose, "stylesheet");
	let out = statements
		.map((s) => scopeStatement(s, wrapper, keyframes))
		.join("\n");
	for (const [old, next] of keyframes) {
		out = out.replace(new RegExp(`\\b${old}\\b`, "g"), next);
	}
	return out;
}
