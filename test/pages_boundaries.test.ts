/*
 * Page-slice boundaries (01-refactor). The control server is composed of
 * pluggable page modules under server/pages/<id>/; a new page must be
 * pluggable with zero edits outside its own directory. These rules pin
 * that:
 *
 *   1. every server/pages/<id>/ is a valid PageModule whose id (and menu id)
 *      equals the directory name — validated by the same assertPageModule
 *      the runtime registry uses;
 *   2. a page never imports another page (cross-page needs go through
 *      named capabilities on PageServices, reached via core);
 *   3. core code and shared/ never import a page (only the generated
 *      manifests under generated/ may name a page);
 *   4. the shell (server/shell) reaches only shell, core, shared and the
 *      generated manifests — never a page's code.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertPageModule } from "../server/core/registry";

const ROOT = resolve(import.meta.dir, "..");
const PAGES_ROOT = "server/pages";

const PAGE_DIRS = readdirSync(join(ROOT, PAGES_ROOT), {
    withFileTypes: true,
})
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

const SOURCE_RE = /\.(ts|tsx)$/;

function walk(dir: string): string[] {
    let entries: Dirent[];
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

const isUnder = (file: string, dir: string): boolean => {
    const rel = relative(join(ROOT, dir), file);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
};

/** `server/pages/<id>` for a file inside a page slice, else undefined. */
function pageOf(file: string): string | undefined {
    if (!isUnder(file, PAGES_ROOT)) return undefined;
    const [id] = relative(join(ROOT, PAGES_ROOT), file).split(sep);
    return id === "" ? undefined : `${PAGES_ROOT}/${id}`;
}

const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const IMPORT_RE =
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']|\bimport\s+type\b[^;]*?from\s*["']([^"']+)["']|\bimport\b[^;]*?from\s*["']([^"']+)["']|\bexport\s+type\b[^;]*?from\s*["']([^"']+)["']|\bexport\b[^;]*?from\s*["']([^"']+)["']/g;

interface Import {
    line: number;
    spec: string;
    target: string;
    typeOnly: boolean;
}

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

describe("page slices", () => {
    test("every page directory is a valid PageModule (id === directory)", async () => {
        expect(PAGE_DIRS.length).toBeGreaterThan(0);
        for (const id of PAGE_DIRS) {
            const mod = (await import(
                join(ROOT, PAGES_ROOT, id, "index.ts")
            )) as { default?: unknown };
            // throws with the page id in the message when invalid
            assertPageModule(mod.default, id);
        }
    });

    test("a page never imports another page at runtime", () => {
        // `import type` is erased: a page may name another page's store types
        // for a capability it pulls, but never run its code.
        const offenders: string[] = [];
        for (const file of walk(join(ROOT, PAGES_ROOT))) {
            const own = pageOf(file);
            for (const imp of importsOf(file)) {
                if (imp.typeOnly) continue;
                const other = pageOf(imp.target);
                if (other && other !== own)
                    offenders.push(describeOffender(file, imp));
            }
        }
        expect(offenders).toEqual([]);
    });

    test("core and shared never import a page at runtime (generated manifests only)", () => {
        // `import type` is erased (core names page store types for the
        // capabilities the module control routes pull); value imports of a
        // page live only in the generated manifests.
        const offenders: string[] = [];
        for (const dir of ["server/core", "shared"]) {
            for (const file of walk(join(ROOT, dir)))
                for (const imp of importsOf(file)) {
                    if (imp.typeOnly) continue;
                    if (pageOf(imp.target) !== undefined)
                        offenders.push(describeOffender(file, imp));
                }
        }
        expect(offenders).toEqual([]);
    });

    test("the shell reaches only shell, core, shared and generated", () => {
        const allowed = ["server/shell", "server/core", "shared", "generated"];
        const offenders: string[] = [];
        for (const file of walk(join(ROOT, "server/shell")))
            for (const imp of importsOf(file))
                if (!allowed.some((dir) => isUnder(imp.target, dir)))
                    offenders.push(describeOffender(file, imp));
        expect(offenders).toEqual([]);
    });
});

/*
 * DynamicForm boundaries (06-dynamic-form). The schema-driven form
 * machinery lives in shared/ (dynamic_form.tsx + the bindableForm helper
 * in overlay/fields.tsx) and is consumed by the overlay element editors.
 * These rules pin its layering and its i18n hygiene:
 *
 *   1. dynamic_form.tsx is a shared leaf — no runtime import from server/;
 *   2. overlay/fields.tsx reaches server/ only via type imports (its values
 *      come from the caller, never from a page);
 *   3. element editors are leaf UI — no runtime import from another page;
 *   4. the overlay i18n catalogues keep key-set parity across every locale;
 *   5. every labelKey an element editor references resolves in its
 *      catalogue — the stale-key detector that catches a missing translation.
 */
describe("dynamic form boundaries", () => {
    test("dynamic_form.tsx is a shared leaf (no runtime import from server/)", () => {
        const file = join(ROOT, "shared/ui/components/dynamic_form.tsx");
        const offenders: string[] = [];
        for (const imp of importsOf(file)) {
            if (imp.typeOnly) continue;
            if (isUnder(imp.target, "server"))
                offenders.push(describeOffender(file, imp));
        }
        expect(offenders).toEqual([]);
    });

    test("overlay/fields.tsx reaches server/ only via type imports", () => {
        const file = join(ROOT, "shared/ui/overlay/fields.tsx");
        const offenders: string[] = [];
        for (const imp of importsOf(file)) {
            if (!isUnder(imp.target, "server")) continue;
            if (imp.typeOnly) continue; // erased — the caller supplies the values
            offenders.push(describeOffender(file, imp));
        }
        expect(offenders).toEqual([]);
    });

    test("element editors are leaf UI (no runtime import from another page)", () => {
        const offenders: string[] = [];
        for (const file of walk(
            join(ROOT, "server/pages/overlays/modules/overlay_elements/elements"),
        )) {
            const own = pageOf(file);
            for (const imp of importsOf(file)) {
                if (imp.typeOnly) continue;
                const other = pageOf(imp.target);
                if (other && other !== own)
                    offenders.push(describeOffender(file, imp));
            }
        }
        expect(offenders).toEqual([]);
    });

    test("overlay i18n catalogues keep key-set parity across every locale", () => {
        const dirs = [
            "server/pages/overlays/modules/overlay_elements/i18n",
            "server/pages/dashboards/modules/chat/i18n",
        ];
        const problems: string[] = [];
        for (const dir of dirs) {
            const files = readdirSync(join(ROOT, dir))
                .filter((f) => f.endsWith(".json"))
                .sort();
            if (files.length < 2) {
                problems.push(
                    `${relative(ROOT, join(ROOT, dir))}: only ${files.length} locale(s)`,
                );
                continue;
            }
            const keyset = (f: string): string =>
                JSON.stringify(
                    Object.keys(
                        JSON.parse(readFileSync(join(ROOT, dir, f), "utf8")),
                    ).sort(),
                );
            const base = keyset(files[0]);
            for (const f of files.slice(1))
                if (keyset(f) !== base)
                    problems.push(
                        `${relative(ROOT, join(ROOT, dir))}/${f} key-set differs from ${files[0]}`,
                    );
        }
        expect(problems).toEqual([]);
    });

    test("element editor labelKeys resolve in their i18n catalogues", () => {
        const oeDir = "server/pages/overlays/modules/overlay_elements/i18n";
        const dcDir = "server/pages/dashboards/modules/chat/i18n";
        const en = (dir: string) =>
            new Set(
                Object.keys(
                    JSON.parse(readFileSync(join(ROOT, dir, "en.json"), "utf8")),
                ),
            );
        const union = new Set<string>([...en(oeDir), ...en(dcDir)]);
        const offenders: string[] = [];
        for (const file of walk(
            join(ROOT, "server/pages/overlays/modules/overlay_elements/elements"),
        ))
            for (const m of stripComments(readFileSync(file, "utf8")).matchAll(
                /labelKey:\s*"([^"]+)"/g,
            ))
                if (!union.has(m[1]))
                    offenders.push(`${relative(ROOT, file)} -> ${m[1]}`);
        expect(offenders).toEqual([]);
    });
});
