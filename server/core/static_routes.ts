/*
 * Static assets for the control server: `/overlay_templates/*`
 * (the storage dir's overlay_templates/: the OBS html_template documents,
 * fetched at runtime by the runtime page; the templates live in the storage
 * dir so the templates page can edit them) plus
 * `/overlay_templates/_catalog.json` (the auto-discovered id list — any
 * `<id>.html` file is a template, no index file is maintained), and `/i18n/*`
 * from the in-memory merged catalogs (core + every module's; see
 * shared/i18n.ts).
 *
 * @elysia/static reads files from a directory on disk; a compiled binary is a
 * flat file and cannot, so these routes are only mounted unbundled (the files
 * were never embedded). Brand images travel with the page bundles instead
 * (hashed under /assets/, embedded in the compiled binary).
 */

import { type Dirent, mkdirSync, readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Elysia } from "elysia";
import { i18nResponse } from "../../shared/http";
import { catalog } from "../../shared/i18n";
import { isCompiledBinary } from "../../shared/util";

/**
 * The runtime template catalog: every `*.html` file in the storage dir's
 * `overlay_templates/` is a template (its id is the filename minus the
 * `.html`). Discovered on each request so a new file is served with no other
 * change; a missing directory (a fresh storage dir) is an empty catalog.
 */
async function templateCatalog(dir: string) {
	let entries: Dirent[];
	try {
		entries = (await readdir(dir, { withFileTypes: true })).filter(
			(e) => e.isFile() && e.name.endsWith(".html"),
		);
	} catch {
		return "[]";
	}
	const withDoc = (
		await Promise.all(
			entries.map(async (e) =>
				(await stat(join(dir, e.name))).isFile() ? e.name : null,
			),
		)
	).filter((id): id is string => id !== null);
	return JSON.stringify(
		withDoc.map((name) => name.slice(0, -".html".length)).sort(),
	);
}

export async function staticRoutes(templatesDir: string) {
	const app = new Elysia({ name: "control-static" }).get(
		"/i18n/*",
		({ request }) => i18nResponse(new URL(request.url).pathname, catalog),
	);
	if (isCompiledBinary()) return app;
	// Registered before the static plugin so it wins over any file at the
	// same path; no static file is kept for it.
	app.get("/overlay_templates/_catalog.json", () => templateCatalog(templatesDir));
	// The templates live in the storage dir (user-editable by the templates
	// page); a fresh deployment has no directory yet — create it eagerly.
	mkdirSync(templatesDir, { recursive: true });
	// Served by hand (not the static plugin): the templates page edits and
	// deletes these files at runtime, and the plugin's in-memory view of the
	// directory outlives the file (a deleted template 500s, not 404s). A
	// direct read per request keeps the served byte stream in sync with the
	// storage dir; the docs are tiny and `no-cache` revalidates them anyway.
	app.get("/overlay_templates/*", ({ request, set }) => {
		const name = decodeURIComponent(
			new URL(request.url).pathname.slice("/overlay_templates/".length),
		);
		if (name.includes("/") || !name.endsWith(".html")) {
			set.status = 404;
			return "Not found";
		}
		const path = join(templatesDir, name);
		try {
			if (!statSync(path).isFile()) throw new Error("missing");
		} catch {
			set.status = 404;
			return "Not found";
		}
		set.status = 200;
		set.headers["content-type"] = "text/html; charset=utf-8";
		set.headers["cache-control"] = "no-cache";
		return readFileSync(path);
	});
	return app;
}
