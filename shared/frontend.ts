import { Buffer } from "node:buffer";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { extname, join } from "node:path";
import { CLIENT_PAGES, SERVER_PAGES } from "./frontend_pages";
import { appPath, MODULE_ROOTS, PAGE_DIRS, PAGES_ROOT } from "./paths";
import { isCompiledBinary } from "./util";

export interface FrontendPageEntry {
    name: string;
    path: string;
}

/**
 * Vendored third-party browser files (`shared/assets/vendor/*`), served
 * under `/assets/vendor/*` alongside the bundle output (e.g. Leaflet for
 * the live-map overlay element). `scripts/gen_control_server_assets.ts`
 * embeds the same files into generated/frontend-assets.ts for the compiled
 * binary, so the set is identical in both modes.
 */
const VENDOR_DIR = "shared/assets/vendor";

const VENDOR_MIME: Record<string, string> = {
    ".css": "text/css",
    ".js": "text/javascript",
    ".png": "image/png",
};

export interface VendorAsset {
    /** Path under `/assets/` (e.g. `vendor/leaflet/leaflet.js`). */
    path: string;
    type: string;
    bytes: Buffer;
}

/** Every file under `shared/assets/vendor`, recursively, sorted by path.
 * A missing directory (a stripped tree) yields an empty set. */
export function vendorAssets(): VendorAsset[] {
    const out: VendorAsset[] = [];
    const walk = (dir: string, prefix: string) => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const file = `${prefix}${entry.name}`;
            if (entry.isDirectory()) walk(join(dir, entry.name), `${file}/`);
            else
                out.push({
                    path: file,
                    type:
                        VENDOR_MIME[extname(entry.name)] ??
                        "application/octet-stream",
                    bytes: readFileSync(join(dir, entry.name)),
                });
        }
    };
    walk(appPath(VENDOR_DIR), "vendor/");
    return out;
}

/**
 * Every page to bundle: both sides' pages (shared/paths PAGE_DIRS) and the
 * module-owned pages (`<module>/pages/*.html`) of every module root. Names
 * must be unique across all of them — they are the keys of `htmlResponse`.
 */
export function frontendPageEntries(): FrontendPageEntry[] {
    const entries: FrontendPageEntry[] = [
        ...CLIENT_PAGES.map((name) => ({
            name,
            path: appPath(`${PAGE_DIRS.client}/${name}.html`),
        })),
        ...SERVER_PAGES.map((name) => ({
            name,
            path: appPath(`${PAGE_DIRS.server}/${name}.html`),
        })),
    ];

    for (const root of MODULE_ROOTS) {
        const modulesDirectory = appPath(root);
        for (const module of readdirSync(modulesDirectory, {
            withFileTypes: true,
        }).sort((left, right) => left.name.localeCompare(right.name))) {
            if (!module.isDirectory()) continue;
            const pagesDirectory = join(modulesDirectory, module.name, "pages");
            let pages;
            try {
                pages = readdirSync(pagesDirectory, {
                    withFileTypes: true,
                }).sort((left, right) => left.name.localeCompare(right.name));
            } catch (error) {
                if (
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "ENOENT"
                )
                    continue;
                throw error;
            }
            for (const page of pages) {
                if (!page.isFile() || !page.name.endsWith(".html")) continue;
                entries.push({
                    name: page.name.slice(0, -".html".length),
                    path: join(pagesDirectory, page.name),
                });
            }
        }
    }

    // Page-slice pages: server/pages/<id>/pages/*.html.
    for (const page of serverSlicePages())
        entries.push(page);

    const names = new Set<string>();
    for (const entry of entries) {
        if (names.has(entry.name))
            throw new Error(`Duplicate frontend page: ${entry.name}`);
        names.add(entry.name);
    }
    return entries;
}

/** The slice-scoped pages: server/pages/<id>/pages/*.html. */
function serverSlicePages(): FrontendPageEntry[] {
    const root = appPath(PAGES_ROOT);
    const entries: FrontendPageEntry[] = [];
    let slices: Dirent[];
    try {
        slices = readdirSync(root, { withFileTypes: true });
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return entries;
        throw error;
    }
    for (const slice of slices.sort((left, right) =>
        left.name.localeCompare(right.name),
    )) {
        if (!slice.isDirectory()) continue;
        const pagesDirectory = join(root, slice.name, "pages");
        let pages: Dirent[];
        try {
            pages = readdirSync(pagesDirectory, {
                withFileTypes: true,
            }).sort((left, right) => left.name.localeCompare(right.name));
        } catch (error) {
            if (
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
            )
                continue;
            throw error;
        }
        for (const page of pages) {
            if (!page.isFile() || !page.name.endsWith(".html")) continue;
            entries.push({
                name: page.name.slice(0, -".html".length),
                path: join(pagesDirectory, page.name),
            });
        }
    }
    return entries;
}

export async function createFrontend() {
    const pages: Record<string, string> = {};
    const assets = new Map<string, Blob>();

    if (isCompiledBinary()) {
        const { default: embedded } = await import(
            "../generated/frontend-assets"
        );
        Object.assign(pages, embedded.pages);
        for (const [file, asset] of Object.entries(embedded.assets)) {
            assets.set(
                file,
                new Blob([Buffer.from(asset.base64, "base64")], {
                    type: asset.type,
                }),
            );
        }
    } else {
        await Bun.$`bun scripts/gen_modules.ts`.quiet();
        await Bun.$`bun scripts/gen_pages.ts`.quiet();
        const entries = frontendPageEntries();
        const result = await Bun.build({
            entrypoints: entries.map((entry) => entry.path),
            target: "browser",
            minify: true,
            splitting: true,
            publicPath: "/assets/",
            naming: {
                asset: "[name]-[hash].[ext]",
                chunk: "[name]-[hash].[ext]",
                entry: "[name]-[hash].[ext]",
            },
        });
        if (!result.success) {
            for (const log of result.logs) console.error(log);
            throw new Error("Failed to bundle the web UI");
        }
        for (const out of result.outputs) {
            const file = out.path.replace(/^\.\//, "");
            const page = entries.find(
                ({ name }) =>
                    file.startsWith(`${name}-`) && file.endsWith(".html"),
            );
            if (page) pages[page.name] = await out.text();
            else assets.set(file, out);
        }
        for (const { name } of entries)
            if (!pages[name])
                throw new Error(`The frontend build omitted ${name}.html`);
        // Vendored browser files (shared/assets/vendor) are not bundler
        // outputs: the compiled binary gets them from the embedded assets
        // instead, the source run reads them from disk here.
        for (const v of vendorAssets())
            assets.set(v.path, new Blob([v.bytes], { type: v.type }));
    }

    const htmlResponse = (page: string) => {
        const html = pages[page];
        if (!html) throw new Error(`Unknown frontend page: ${page}`);
        return new Response(html, {
            headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-cache",
            },
        });
    };

    return { assets, htmlResponse };
}
