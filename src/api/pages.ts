import { Elysia } from "elysia";
import {
    i18nResponse,
    imageResponse,
    notFound,
} from "../http";
import type { createFrontend } from "../frontend";
import { catalog } from "../i18n";
import { setupRequired } from "../state";

const PIPELINE_EDIT_RE = /^\/pipelines\/(new|edit\/[^/]+)\/?$/;

type Frontend = Awaited<ReturnType<typeof createFrontend>>;

export function devicePagesPlugin(frontend: Frontend) {
    return new Elysia({ name: "device-api-pages" })
        .get("/", () => frontend.htmlResponse(setupRequired ? "setup" : "index"))
        .get("/assets/*", ({ request }) => {
            const path = new URL(request.url).pathname;
            const asset = frontend.assets.get(
                path.slice("/assets/".length),
            );
            return asset
                ? new Response(asset, {
                      headers: {
                          "cache-control":
                              "public, max-age=31536000, immutable",
                      },
                  })
                : notFound();
        })
        .get("/settings", ({ request }) =>
            new URL(request.url).pathname.endsWith("/")
                ? frontend.htmlResponse("settings")
                : Response.redirect("/settings/", 308),
        )
        .get("/setup", ({ request }) =>
            new URL(request.url).pathname.endsWith("/")
                ? frontend.htmlResponse("setup")
                : Response.redirect("/setup/", 308),
        )
        .get("/pipelines/*", ({ request }) => {
            const path = new URL(request.url).pathname;
            if (!PIPELINE_EDIT_RE.test(path)) return notFound();
            return path.endsWith("/")
                ? frontend.htmlResponse("pipelineedit")
                : Response.redirect(`${path}/`, 308);
        })
        .get("/i18n/*", ({ request }) =>
            i18nResponse(new URL(request.url).pathname, catalog),
        )
        .get("/img/*", async ({ request }) => {
            const response = await imageResponse(
                new URL(request.url).pathname,
            );
            return response ?? notFound();
        })
        .all("*", () => notFound());
}
