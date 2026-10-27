/*
 * Static assets for the control server: `/img/*` (frontend/img: role
 * diagrams, brand logo, favicon) through @elysia/static, and `/i18n/*` from
 * the in-memory merged catalogs (core + every module's; see shared/i18n.ts).
 *
 * @elysia/static reads files from a directory on disk; a compiled binary is a
 * flat file and cannot, so the image routes are only mounted unbundled (the
 * images were never embedded).
 */

import staticPlugin from "@elysia/static";
import { Elysia } from "elysia";
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

export async function staticRoutes(frontendDirectory: URL) {
    const app = new Elysia({ name: "control-static" }).get(
        "/i18n/*",
        ({ request }) => i18nResponse(new URL(request.url).pathname, catalog),
    );
    if (isCompiledBinary()) return app;
    app.use(
        await staticPlugin({
            assets: new URL("img", frontendDirectory).pathname,
            prefix: "/img",
            ...STATIC_OPTIONS,
        }),
    );
    return app;
}
