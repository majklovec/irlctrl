/*
 * Entity pages: every page name in shared/frontend_pages.ts is an HTML entry
 * whose script is the same-named TSX, and the page names follow
 * `<entity>_<verb>` (`dashboard_list`, `overlay_update`, …) so a page's URL,
 * file and route all say which entity view it is. Each server page is also
 * served by a route (htmlResponse(<name>)).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLIENT_PAGES, SERVER_PAGES } from "../shared/frontend_pages";
import { PAGE_DIRS } from "../shared/paths";

const ROOT = resolve(import.meta.dir, "..");
const ENTITY_PAGE_RE = /^[a-z]+_(list|add|view|update)$/;
const ENTITY_PAGE_EXEMPT = new Set([
    // device-local and account pages: no entity behind them
    "index",
    "setup",
    "settings",
    "login",
    "register",
    "profile",
]);

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
            ? walk(join(dir, e.name))
            : e.name.endsWith(".ts")
              ? [join(dir, e.name)]
              : [],
    );
}

describe("entity pages", () => {
    for (const [side, names] of [
        ["client", CLIENT_PAGES],
        ["server", SERVER_PAGES],
    ] as const) {
        const dir = join(ROOT, PAGE_DIRS[side]);
        test(`${side}: every page has an HTML entry loading its same-named script`, () => {
            for (const name of names) {
                const html = join(dir, `${name}.html`);
                expect(existsSync(html), `${html} missing`).toBe(true);
                const src = readFileSync(html, "utf8");
                // the device home page is index.html by web convention; its
                // script says what it is (device_page.tsx)
                const expected = name === "index" ? "device_page" : name;
                expect(src, `${name}.html does not load ${expected}.tsx`).toMatch(
                    new RegExp(`src="[^"]*/${expected}\\.tsx"`),
                );
                const script = src.match(/src="([^"]+\.tsx)"/)?.[1] ?? "";
                expect(existsSync(resolve(dir, script)), `${script} missing`).toBe(true);
            }
        });
        test(`${side}: no stray HTML entries outside the page list`, () => {
            const files = readdirSync(dir)
                .filter((f) => f.endsWith(".html"))
                .map((f) => f.slice(0, -".html".length))
                .sort();
            expect(files).toEqual([...names].sort());
        });
    }

    test("page names are <entity>_<list|add|view|update> (account/device pages exempt)", () => {
        const offenders = [...CLIENT_PAGES, ...SERVER_PAGES].filter(
            (name) => !ENTITY_PAGE_EXEMPT.has(name) && !ENTITY_PAGE_RE.test(name),
        );
        expect(offenders).toEqual([]);
    });

    test("every server page is served by a route", () => {
        const served = new Set<string>();
        for (const file of walk(join(ROOT, "server/backend")))
            for (const m of readFileSync(file, "utf8").matchAll(
                /htmlResponse\(\s*"([a-z_]+)"\s*\)/g,
            ))
                served.add(m[1]);
        const unserved = SERVER_PAGES.filter((name) => !served.has(name));
        expect(unserved).toEqual([]);
    });
});
