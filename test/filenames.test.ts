/*
 * File naming convention: every source file and directory under the code
 * roots is snake_case (`module_registry.ts`, `overlay_elements/`,
 * `device_list.test.ts`). Entity pages follow `<entity>_<verb>` on top of
 * that (`dashboard_list.tsx`, `overlay_update.tsx`), so a page's file name
 * says which entity view it is.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CODE_ROOTS = ["client", "server", "shared", "scripts", "test"];
const SOURCE_RE = /\.(ts|tsx|css|html)$/;
/** stem + optional `.test` / `.d` marker + extension */
const FILE_RE = /^[a-z0-9_]+(\.test|\.d)?\.(ts|tsx|css|html)$/;
const DIR_RE = /^[a-z0-9_]+$/;
/** Directories whose contents are not source code (assets, translations). */
const SKIP = new Set([
    "node_modules",
    "img",
    "pwa",
    "i18n",
    "defaults",
    // build-time generated manifests (gitignored, not hand-written)
    "generated",
]);

function walk(dir: string, out: { files: string[]; dirs: string[] }) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.dirs.push(path);
            walk(path, out);
        } else if (SOURCE_RE.test(entry.name)) out.files.push(path);
    }
    return out;
}

describe("file naming convention", () => {
    const tree = { files: [] as string[], dirs: [] as string[] };
    for (const root of CODE_ROOTS) walk(join(ROOT, root), tree);

    test("source files are snake_case", () => {
        const offenders = tree.files
            .filter((file) => !FILE_RE.test(file.slice(file.lastIndexOf("/") + 1)))
            .map((file) => relative(ROOT, file));
        expect(offenders).toEqual([]);
    });

    test("source directories are snake_case", () => {
        const offenders = tree.dirs
            .filter((dir) => !DIR_RE.test(dir.slice(dir.lastIndexOf("/") + 1)))
            .map((dir) => relative(ROOT, dir));
        expect(offenders).toEqual([]);
    });
});
