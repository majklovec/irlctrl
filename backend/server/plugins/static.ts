/*
 * Static assets (images and i18n catalogs) for the control server, served with
 * the @elysia/static plugin.
 *
 * @elysia/static reads files from a directory on disk. A compiled binary only
 * embeds `i18n/` (`--asset i18n`); the image assets are not embedded and a
 * flat binary cannot reach disk at all. So in a compiled binary we skip the
 * plugin and serve i18n from the in-memory `catalog` (images were unservable in
 * a compiled binary before, too).
 */
import { Elysia } from "elysia";
import staticPlugin from "@elysia/static";
import { i18nResponse } from "../../../shared/http";
import { catalog } from "../../../shared/i18n";
import { isCompiledBinary } from "../../../shared/util";

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
 * `/img/*` (frontend/img: role diagrams, brand logo, favicon) and `/i18n/*`
 * (i18n catalogs). Unbundled → @elysia/static from disk; compiled → i18n from
 * the embedded catalog (images are not embedded and were unservable anyway).
 */
export async function staticRoutes(frontendDirectory: URL) {
	const app = new Elysia({ name: "control-static" });
	if (isCompiledBinary()) {
		app.get("/i18n/*", ({ request }) =>
			i18nResponse(new URL(request.url).pathname, catalog),
		);
		return app;
	}
	app.use(
		await staticPlugin({
			assets: new URL("img", frontendDirectory).pathname,
			prefix: "/img",
			...STATIC_OPTIONS,
		}),
	);
	app.use(
		await staticPlugin({
			assets: new URL("../../../i18n", import.meta.url).pathname,
			prefix: "/i18n",
			...STATIC_OPTIONS,
		}),
	);
	return app;
}
