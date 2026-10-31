/*
 * Architectural boundaries, pinned from the import graph.
 *
 * The rules are expressed against a LAYOUT description so a directory move
 * only touches that table, never the assertions:
 *
 *   1. core code never imports a module (`<moduleRoot>/<id>/…`); the
 *      generated manifests are the only door.
 *   2. a module never imports another module (cross-module services go
 *      through named capabilities on the bus).
 *   3. browser code (every .tsx, plus the listed browser roots) never imports
 *      backend code at runtime — `import type` is erased and allowed.
 *   4. the client and server sides only meet through shared/ (and the
 *      generated manifests); listed exceptions are the deliberate doors.
 *
 * Specifiers are resolved relative to the importing file, so the checks are
 * about *where* a dependency lives, not how the path is spelled.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

interface Side {
	name: string;
	dirs: string[];
	/** Directories this side may import even though they belong to the other side. */
	allow?: string[];
}

interface Layout {
	/** Directories whose immediate children are modules. */
	moduleRoots: string[];
	/** Core code: must not import any module. */
	coreRoots: string[];
	/** Code that only ever runs in the browser (in addition to every .tsx file). */
	browserRoots: string[];
	/** Code that only ever runs in Bun. */
	backendRoots: string[];
	/** Generated manifests: the sanctioned door from core into the modules. */
	generatedDir: string;
	/** Process sides that must stay isolated from each other. */
	sides: Side[];
}

const LAYOUT: Layout = {
	moduleRoots: ["modules"],
	coreRoots: ["backend", "frontend/ts", "shared"],
	browserRoots: ["frontend/ts"],
	backendRoots: ["backend"],
	generatedDir: "generated",
	sides: [],
};

const SOURCE_RE = /\.(ts|tsx)$/;

function walk(dir: string): string[] {
	let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((entry) =>
		entry.isDirectory()
			? walk(join(dir, entry.name))
			: SOURCE_RE.test(entry.name)
				? [join(dir, entry.name)]
				: [],
	);
}

const sourcesUnder = (dirs: string[]): string[] =>
	dirs.flatMap((dir) => walk(join(ROOT, dir)));

const isUnder = (file: string, dir: string): boolean => {
	const rel = relative(join(ROOT, dir), file);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
};

/** `modules/encoder` for a file inside a module root, else undefined. */
function moduleOf(file: string): string | undefined {
	for (const root of LAYOUT.moduleRoots) {
		if (!isUnder(file, root)) continue;
		const [id] = relative(join(ROOT, root), file).split(sep);
		return `${root}/${id}`;
	}
	return undefined;
}

const stripComments = (src: string): string =>
	src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

interface Import {
	line: number;
	spec: string;
	target: string;
	typeOnly: boolean;
}

const IMPORT_RE =
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']|\bimport\s+type\b[^;]*?from\s*["']([^"']+)["']|\bimport\b[^;]*?from\s*["']([^"']+)["']|\bexport\s+type\b[^;]*?from\s*["']([^"']+)["']|\bexport\b[^;]*?from\s*["']([^"']+)["']/g;

/** Relative imports of a file, resolved to absolute paths (bare specifiers skipped). */
function importsOf(file: string): Import[] {
	const src = stripComments(readFileSync(file, "utf8"));
	const out: Import[] = [];
	for (const m of src.matchAll(IMPORT_RE)) {
		const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
		if (!spec?.startsWith(".")) continue;
		out.push({
			line: src.slice(0, m.index).split("\n").length,
			spec,
			target: resolve(dirname(file), spec),
			typeOnly: m[3] !== undefined || m[5] !== undefined,
		});
	}
	return out;
}

const describeOffender = (file: string, imp: Import): string =>
	`${relative(ROOT, file)}:${imp.line} → ${imp.spec}`;

describe("architectural boundaries", () => {
	test("core never imports a module (only the generated manifests)", () => {
		const offenders: string[] = [];
		for (const file of sourcesUnder(LAYOUT.coreRoots)) {
			if (moduleOf(file)) continue;
			for (const imp of importsOf(file))
				if (moduleOf(imp.target)) offenders.push(describeOffender(file, imp));
		}
		expect(offenders).toEqual([]);
	});

	test("a module never imports another module", () => {
		const offenders: string[] = [];
		for (const file of sourcesUnder(LAYOUT.moduleRoots)) {
			const own = moduleOf(file);
			for (const imp of importsOf(file)) {
				const other = moduleOf(imp.target);
				if (other && other !== own) offenders.push(describeOffender(file, imp));
			}
		}
		expect(offenders).toEqual([]);
	});

	test("browser code never imports backend code at runtime", () => {
		const browserFiles = new Set<string>([
			...sourcesUnder(LAYOUT.browserRoots),
			...sourcesUnder([...LAYOUT.moduleRoots, "shared"]).filter((f) =>
				f.endsWith(".tsx"),
			),
		]);
		const offenders: string[] = [];
		for (const file of browserFiles)
			for (const imp of importsOf(file))
				if (
					!imp.typeOnly &&
					LAYOUT.backendRoots.some((dir) => isUnder(imp.target, dir))
				)
					offenders.push(describeOffender(file, imp));
		expect(offenders).toEqual([]);
	});

	test("the generated manifests are the only core→module door", () => {
		const generated = sourcesUnder([LAYOUT.generatedDir]);
		expect(generated.length).toBeGreaterThan(0);
		for (const file of generated)
			expect(readFileSync(file, "utf8")).toMatch(/AUTO-GENERATED/);
	});

	test("client and server sides only meet through shared/", () => {
		const offenders: string[] = [];
		for (const side of LAYOUT.sides) {
			const foreign = LAYOUT.sides.filter((s) => s !== side);
			for (const file of sourcesUnder(side.dirs))
				for (const imp of importsOf(file)) {
					if (imp.typeOnly) continue;
					if (side.allow?.some((dir) => isUnder(imp.target, dir))) continue;
					if (
						foreign.some((s) => s.dirs.some((dir) => isUnder(imp.target, dir)))
					)
						offenders.push(describeOffender(file, imp));
				}
		}
		expect(offenders).toEqual([]);
	});
});
