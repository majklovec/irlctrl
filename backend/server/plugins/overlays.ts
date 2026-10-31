/*
 * OBS overlay editor routes:
 *   GET  /overlays/                the editor page (cookie auth)
 *   GET  /overlay/:slug?token=…    the runtime page (token auth, transparent)
 *   WS   /overlay/:slug/ws?token=… the runtime live feed (token auth)
 *   …    /api/overlays…            the editor REST API (cookie auth)
 *
 * The runtime page is what OBS loads as a Browser Source: no session, only
 * the project token (chat-overlay pattern), a fully transparent body.
 */
import { Elysia } from "elysia";
import type { createFrontend } from "../../../shared/frontend";
import { upgradeRequired } from "../../../shared/http";
import type { createAuth } from "../auth";
import { event } from "../contracts";
import { type Overlays, overlayRuntimeTopic } from "../overlays";
import { authenticatedHandler } from "./authenticated";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Frontend = Awaited<ReturnType<typeof createFrontend>>;

const RUNTIME_HEADERS = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
};

const RUNTIME_WS_RE = /^\/overlay\/([^/]+)\/ws\/?$/;
const TOKEN_PARAM = "token";

function runtimeToken(request: Request): string {
    return new URL(request.url).searchParams.get(TOKEN_PARAM) ?? "";
}

/** The runtime page HTML: served even for a bad token so OBS shows a blank
 * (transparent) page — no error text, no background (handoff §7.3). */
function runtimePage(frontend: Frontend): Response {
    const response = frontend.htmlResponse("overlay");
    for (const [key, value] of Object.entries(RUNTIME_HEADERS))
        response.headers.set(key, value);
    return response;
}

export function overlayRoutes(
    auth: Auth,
    overlays: Overlays,
    frontend: Frontend,
) {
    return new Elysia({ name: "control-overlays" })
        .get(
            "/overlays/",
            authenticatedHandler(auth, () => frontend.htmlResponse("overlays")),
        )
        .get("/overlay/:slug", () => runtimePage(frontend))
        .all(
            "/api/overlays",
            authenticatedHandler(auth, (request, user) =>
                overlays.api(request, new URL(request.url), user),
            ),
        )
        .all(
            "/api/overlays/*",
            authenticatedHandler(auth, (request, user) =>
                overlays.api(request, new URL(request.url), user),
            ),
        )
        .get("/overlay/:slug/ws", () => upgradeRequired())
        .ws("/overlay/:slug/ws", {
            open(ws) {
                const m = new URL(ws.data.request.url).pathname.match(RUNTIME_WS_RE);
                if (!m) return ws.close(1008, "Unknown overlay route");
                const slug = decodeURIComponent(m[1]);
                const feed = overlays.runtimeScene(runtimeToken(ws.data.request), slug);
                if (!feed) return ws.close(1008, "Invalid overlay token");
                // snapshot first, then the live topic (the server publishes
                // topic messages to this socket from the next tick on)
                ws.subscribe(overlayRuntimeTopic(feed.user));
                ws.send(
                    event("overlays.snapshot", {
                        scene: feed.scene,
                        variables: feed.variables,
                        canvas: feed.canvas,
                        assets: feed.assets,
                    }),
                );
            },
        });
}
