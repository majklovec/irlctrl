/*
 * OBS overlay editor routes:
 *   GET  /overlays/                the overlay list page (cookie auth)
 *   GET  /overlays/edit/:id/       the scene editor page (cookie auth)
 *   GET  /overlay/:slug?token=…    the runtime page (token auth, transparent)
 *   GET  /overlay/variables/:id    revalue one variable (token auth, ?value=…)
 *   WS   /overlay/:slug/ws?token=… the runtime live feed (token auth)
 *   …    /api/overlays…            the editor REST API (cookie auth)
 *
 * The runtime page is what OBS loads as a Browser Source: no session, only
 * the project token (chat-overlay pattern), a fully transparent body.
 */
import { Elysia } from "elysia";
import type { createFrontend } from "../../../shared/frontend";
import { upgradeRequired } from "../../../shared/http";
import type { createAuth } from "../auth/auth";
import { event } from "../contracts";
import { ApiError, type Overlays, overlayRuntimeTopic } from "./overlay_store";
import { authenticatedHandler } from "../auth/authenticated";

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
    const response = frontend.htmlResponse("overlay_view");
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
            authenticatedHandler(auth, () => frontend.htmlResponse("overlay_list")),
        )
        .get(
            "/overlays/edit/*",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("overlay_update"),
            ),
        )
        .get("/overlay/:slug", () => runtimePage(frontend))
        .get(
            "/overlay/variables/:id",
            ({ params, request }) => {
                const value = new URL(request.url).searchParams.get("value");
                let result:
                    | { status: number; body: Record<string, unknown> }
                    | null;
                try {
                    result = overlays.setVariableByToken(
                        runtimeToken(request),
                        params.id,
                        value,
                    );
                } catch (err: unknown) {
                    const code = err instanceof ApiError ? err.code : 500;
                    return Response.json(
                        {
                            ok: false,
                            error:
                                err instanceof Error ? err.message : "Internal error",
                            code,
                        },
                        { status: code },
                    );
                }
                // token probe — hide project existence, exactly like /overlay/:slug
                if (!result)
                    return Response.json(
                        { ok: false, error: "Not found", code: 404 },
                        { status: 404 },
                    );
                return Response.json(result.body, { status: result.status });
            },
        )
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
