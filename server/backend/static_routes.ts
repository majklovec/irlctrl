/*
 * Static assets for the control server: `/img/*` (shared/assets/img: brand
 * logo, favicon), `/overlay_templates/*` (public/overlay_templates: the
 * OBS html_template documents, fetched at runtime by the runtime page) plus
 * `/overlay_templates/_catalog.json` (the auto-discovered id list — any
 * subfolder holding an `index.html` is a template, no index file is
 * maintained), and `/i18n/*` from the in-memory merged catalogs (core +
 * every module's; see shared/i18n.ts).
 *
 * @elysia/static reads files from a directory on disk; a compiled binary is a
 * flat file and cannot, so these routes are only mounted unbundled (the files
 * were never embedded).
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import staticPlugin from "@elysia/static";
import { Elysia } from "elysia";
import { i18nResponse } from "../../shared/http";
import { catalog } from "../../shared/i18n";
import { ASSETS_DIR, appPath } from "../../shared/paths";
import { isCompiledBinary } from "../../shared/util";

/** Repo-relative directory of the OBS html_template documents. */
const OVERLAY_TEMPLATES_DIR = "public/overlay_templates";

// These assets are tiny and path-stable, so revalidate on every request to
// match the previous hand-rolled `no-cache` behavior.
const STATIC_OPTIONS = {
    directive: "no-cache" as const,
    maxAge: null,
    etag: true,
    indexHTML: false,
    silent: true,
};

/**
 * The runtime template catalog: every subfolder of
 * `public/overlay_templates/` that holds an `index.html` is a template.
 * Discovered on each request so a new folder is served with no other change.
 */
async function templateCatalog() {
    const dir = appPath(OVERLAY_TEMPLATES_DIR);
    const entries = (await readdir(dir, { withFileTypes: true })).filter((e) =>
        e.isDirectory(),
    );
    const withDoc = (
        await Promise.all(
        	entries.map(async (e) =>
        		(
        			await stat(join(dir, e.name, "index.html"))
        		).isFile()
        			? e.name
        			: null,
        	),
        )
    ).filter((id): id is string => id !== null);
    return JSON.stringify(withDoc.sort());
}

export async function staticRoutes() {
    const app = new Elysia({ name: "control-static" }).get(
        "/i18n/*",
        ({ request }) => i18nResponse(new URL(request.url).pathname, catalog),
    );
    if (isCompiledBinary()) return app;
    // Registered before the static plugin so it wins over any file at the
    // same path; no static file is kept for it.
    app.get("/overlay_templates/_catalog.json", () => templateCatalog());
    app.use(
        await staticPlugin({
            assets: appPath(`${ASSETS_DIR}/img`),
            prefix: "/img",
            ...STATIC_OPTIONS,
        }),
    );
    app.use(
        await staticPlugin({
            assets: appPath(OVERLAY_TEMPLATES_DIR),
            prefix: "/overlay_templates",
            ...STATIC_OPTIONS,
        }),
    );
    return app;
}
