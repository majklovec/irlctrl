/*
 * The `:root` variable reader: turns a template's stylesheet into the
 * ordered list of custom properties it declares (name + fallback value).
 * The inspector renders one editable field per entry (element.tsx); the
 * fallback is what the render shows while the element has no override —
 * the scoped stylesheet collapses `:root` onto the wrapper class and the
 * per-element overrides ride the wrapper's inline style.
 *
 * PURE on purpose (no DOM): unit-testable and reusable by a future server
 * renderer. The template contract (css_scope) guarantees `:root` appears
 * as a standalone selector, so the first `:root { … }` block is the one.
 */

/** One declared custom property: `--name` + its fallback value. */
export type RootVar = [name: string, value: string];

const ROOT_RE = /:root\s*\{([\s\S]*?)\}/;
const NAME_RE = /^--[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * Parse the template stylesheet's `:root` block into ordered
 * [name, value] pairs. Comments are stripped first (the authoring header
 * sits above the rule). A missing block or a malformed entry yields `[]` /
 * is skipped — the inspector simply shows fewer fields; the render is
 * unaffected (every `:root` prop keeps its fallback by contract).
 */
export function parseRootVars(css: string): RootVar[] {
	const block = ROOT_RE.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1];
	if (block === undefined) return [];
	const out: RootVar[] = [];
	for (const part of block.split(";")) {
		const idx = part.indexOf(":");
		if (idx < 0) continue;
		const name = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (NAME_RE.test(name) && value !== "") out.push([name, value]);
	}
	return out;
}

/**
 * The human label for a declared custom property — the name without the
 * `--` prefix, its `-`/`_` separators become spaces and only the first
 * letter is capitalised: `--corner-glow` → `Corner glow`. A blank result
 * (e.g. `--`) falls back to the raw name.
 */
export function rootVarLabel(name: string): string {
	const label = name.replace(/^--/, "").replace(/[-_]+/g, " ").trim();
	if (label === "") return name;
	return label[0].toUpperCase() + label.slice(1);
}
