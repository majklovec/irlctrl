/*
 * Page registry — the only file that knows the physical `server/pages/`
 * layout.
 *
 * Discovery has two modes, mirroring shared/registry.ts (the module
 * registry — this page system is parallel to it, never merged with it):
 *
 *  - unbundled (`bun server/main.ts`, `bun test`): a runtime
 *    directory scan anchored on the repo layout — adding a page needs no
 *    edit here.
 *  - compiled binaries (`bun build --compile`): the build-time manifest
 *    generated/pages.server.ts (scripts/gen_pages.ts); a compiled
 *    process cannot readdir (import.meta.url lives in Bun's virtual /$bunfs
 *    mount).
 *
 * Init runs in dependency order (a page's `dependencies` are init'ed first)
 * so the capability map is populated before a page pulls from it; the
 * stored list is then sorted by menu order.
 *
 * Pages may never import core/registry.ts (circular discovery): they
 * receive everything through `init(services)`.
 */
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { appPath, PAGES_ROOT } from "../../shared/paths";
import { isCompiledBinary } from "../../shared/util";
import type {
    CapabilityRegistry,
    MenuContribution,
    PageModule,
    PageServices,
} from "./contracts";

export function createCapabilities(): CapabilityRegistry {
    const map = new Map<string, unknown>();
    return {
        provide(name, value) {
            if (map.has(name))
                throw new Error(`capability ${name} provided twice`);
            map.set(name, value);
        },
        has: (name) => map.has(name),
        require<T>(name): T {
            if (!map.has(name))
                throw new Error(`missing capability ${name} — is the providing page in dependencies?`);
            return map.get(name) as T;
        },
    };
}

const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validate a PageModule the way the module registry validates modules: strict, with the page id in every message. */
export function assertPageModule(page: unknown, id: string): asserts page is PageModule {
    const m = page as Partial<PageModule> | null;
    const fail = (what: string): never => {
        throw new Error(`page ${id}: ${what}`);
    };
    if (!m || typeof m !== "object") fail("missing PageModule default export");
    if (m.id !== id) fail(`id "${m.id ?? ""}" must match the directory name`);
    if (!m.menu || typeof m.menu !== "object") fail("missing menu contribution");
    const menu = m.menu as Partial<MenuContribution>;
    if (menu.id !== id) fail(`menu.id "${menu.id ?? ""}" must match the directory name`);
    if (typeof menu.labelKey !== "string" || menu.labelKey === "")
        fail("menu.labelKey must be a non-empty i18n key");
    if (typeof menu.path !== "string" || !menu.path.startsWith("/"))
        fail("menu.path must be an absolute path");
    if (menu.order !== undefined && !Number.isFinite(menu.order))
        fail("menu.order must be a finite number");
    if (m.dependencies !== undefined && !isStringArray(m.dependencies))
        fail("dependencies must be a string array of page ids");
    if (!m.backend || typeof m.backend !== "object") fail("missing backend half");
    if (!(m.backend.routes instanceof Elysia))
        fail("backend.routes must be an Elysia plugin");
    if (m.backend.init !== undefined && typeof m.backend.init !== "function")
        fail("backend.init must be a function");
    if (!m.frontend || typeof m.frontend !== "object")
        fail("missing frontend half");
    if (!isStringArray(m.frontend.pages))
        fail("frontend.pages must be a string array of HTML entry names");
}

/**
 * Deterministic init order: topological over declared `dependencies`
 * (a page comes after the pages it depends on), ties broken by id. Unknown
 * dependency ids and cycles throw at load.
 */
function resolveInitOrder(mods: PageModule[]): PageModule[] {
    const byId = new Map(mods.map((p) => [p.id, p]));
    const order: PageModule[] = [];
    const done = new Set<string>();
    const onStack = new Set<string>();
    const visit = (page: PageModule): void => {
        if (done.has(page.id)) return;
        if (onStack.has(page.id))
            throw new Error(`page dependency cycle at ${page.id}`);
        onStack.add(page.id);
        for (const dep of page.dependencies ?? []) {
            const target = byId.get(dep);
            if (!target)
                throw new Error(
                    `page ${page.id} depends on unknown page ${dep}`,
                );
            visit(target);
        }
        onStack.delete(page.id);
        done.add(page.id);
        order.push(page);
    };
    for (const page of [...mods].sort((a, b) => a.id.localeCompare(b.id)))
        visit(page);
    return order;
}

let pages: PageModule[] = [];
let ready = false;

async function scanPages(): Promise<PageModule[]> {
    const root = appPath(PAGES_ROOT);
    let entries: Dirent[];
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return [];
        throw error;
    }
    const found: PageModule[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const mod = (await import(
            join(root, entry.name, "index.ts")
        )) as { default?: unknown };
        assertPageModule(mod.default, entry.name);
        found.push(mod.default);
    }
    return found;
}

export async function discoverPages(
    services: PageServices,
): Promise<PageModule[]> {
    if (ready) return pages;
    const found = isCompiledBinary()
        ? (
              (await import("../../generated/pages.server")) as {
                  PAGE_MODULES: PageModule[];
              }
          ).PAGE_MODULES
        : await scanPages();
    for (const page of found) assertPageModule(page, page.id);
    const ordered = resolveInitOrder(found);
    for (const page of ordered) await page.backend.init?.(services);
    pages = [...ordered].sort(
        (a, b) => (a.menu.order ?? 100) - (b.menu.order ?? 100),
    );
    ready = true;
    return pages;
}

export function getPages(): PageModule[] {
    if (!ready)
        throw new Error("discoverPages must be called before getPages");
    return pages;
}

export function getMenu(): MenuContribution[] {
    return getPages().map((p) => p.menu);
}

export function mountRoutes(app: Elysia): void {
    for (const page of getPages()) app.use(page.backend.routes);
}

/** Reset the cached discovery (test hook: each test process gets a fresh registry). */
export function resetPages(): void {
    pages = [];
    ready = false;
}
