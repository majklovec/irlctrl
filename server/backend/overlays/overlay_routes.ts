/*
 * OBS overlay editor routes:
 *   GET  /overlays/                the overlay list page (cookie auth)
 *   GET  /overlays/edit/:id/       the overlay editor page (cookie auth)
 *   GET  /overlay/:id?token=…      the runtime page (token auth, transparent)
 *   GET  /overlay/variables?…      revalue variables: ?<name>=<value>…, an
 *                                  empty value clears (token auth)
 *   POST /overlay/variables?…      revalue variables from a JSON body
 *                                  {<name>: value|null} (token auth)
 *   GET  /overlay/alert/:name?…    trigger an alert whose element event
 *                                  matches <name>; optional ?<name>=<value>
 *                                  pairs ride with the alert and land in
 *                                  overlay variables when the alert plays
 *                                  (token auth)
 *   WS   /overlay/:id/ws?token=…   the runtime live feed (token auth);
 *                                  also accepts the runtime page's
 *                                  `overlays.applyAlert` uplink (it writes
 *                                  an on-air alert's values to variables)
 *   POST /api/overlays/:id/duplicate
 *                            copy an overlay (cookie auth); the clone gets a
 *                            fresh id, name and token
 *   …    /api/overlays…            the editor REST API (cookie auth)
 *
 * The runtime page is what OBS loads as a Browser Source: no session, only
 * the overlay token (chat-overlay pattern), a fully transparent body.
 */
import { Elysia } from "elysia";
import { APP_VERSION } from "../../../shared/app_version";
import type { createFrontend } from "../../../shared/frontend";
import { upgradeRequired } from "../../../shared/http";
import { socketMessage } from "../../../shared/socket_message";
import type { createAuth } from "../auth/auth";
import { authenticatedHandler } from "../auth/authenticated";
import { event } from "../contracts";
import { ApiError, type Overlays, overlayRuntimeTopic } from "./overlay_store";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Frontend = Awaited<ReturnType<typeof createFrontend>>;

/** Runs a token-authenticated store action and maps the outcome: ApiError
 * → JSON `{ok:false, error, code}`, `null` → 404 "Not found" (a token probe
 * must not leak project existence, exactly like /overlay/:id). */
type TokenResult = { status: number; body: Record<string, unknown> } | null;

function tokenJson(
    action: () => TokenResult | Promise<TokenResult>,
): Promise<Response> {
    return (async (): Promise<Response> => {
        let result: TokenResult;
        try {
            result = await action();
        } catch (err: unknown) {
            const code = err instanceof ApiError ? err.code : 500;
            return Response.json(
                {
                    ok: false,
                    error:
                        err instanceof Error
                            ? err.message
                            : "Internal error",
                    code,
                },
                { status: code },
            );
        }
        if (!result)
            return Response.json(
                { ok: false, error: "Not found", code: 404 },
                { status: 404 },
            );
        return Response.json(result.body, { status: result.status });
    })();
}

/** Query params of the token endpoints, `token` excluded:
 * `?<name>=<value>…` pairs. */
function queryValues(request: Request): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [name, value] of new URL(request.url).searchParams)
        if (name !== TOKEN_PARAM) values[name] = value;
    return values;
}

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
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("overlay_list"),
            ),
        )
        .get(
            "/overlays/edit/*",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("overlay_update"),
            ),
        )
        // before /overlay/:id — the static paths must win over the scene id
        .get(
            "/overlay/variables",
            ({ request }) =>
                tokenJson(() =>
                    overlays.setVariablesByToken(
                        runtimeToken(request),
                        queryValues(request),
                    ),
                ),
        )
        .post(
            "/overlay/variables",
            ({ request }) =>
                tokenJson(async () => {
                    // JSON body: {<name>: value|null} — null/"" clears
                    let body: unknown;
                    try {
                        body = await request.json();
                    } catch {
                        throw new ApiError("body must be valid JSON", 400);
                    }
                    if (
                        typeof body !== "object" ||
                        body === null ||
                        Array.isArray(body)
                    )
                        throw new ApiError(
                            "body must be a JSON object of variable name → value",
                            400,
                        );
                    return overlays.setVariablesByToken(
                        runtimeToken(request),
                        body as Record<string, unknown>,
                    );
                }),
        )
        .get(
            "/overlay/alert/:name",
            ({ request, params }) =>
                tokenJson(() => {
                    // query pairs (if any) set project variables; the
                    // trigger itself is the URL's <name>
                    return overlays.triggerAlertByToken(
                        runtimeToken(request),
                        decodeURIComponent(params.name),
                        queryValues(request),
                    );
                }),
        )
        .get("/overlay/:id", () => runtimePage(frontend))
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
        .get("/overlay/:id/ws", () => upgradeRequired())
        .ws("/overlay/:id/ws", {
            open(ws) {
                const m = new URL(ws.data.request.url).pathname.match(
                    RUNTIME_WS_RE,
                );
                if (!m) return ws.close(1008, "Unknown overlay route");
                const overlayId = decodeURIComponent(m[1]);
                const feed = overlays.runtimeOverlay(
                    runtimeToken(ws.data.request),
                    overlayId,
                );
                if (!feed) return ws.close(1008, "Invalid overlay token");
                // the message handler reuses the already-validated overlay id
                (ws.data as { overlayId?: string }).overlayId = overlayId;
                // snapshot first, then the live topic (the server publishes
                // topic messages to this socket from the next tick on)
                ws.subscribe(overlayRuntimeTopic(overlayId));
                const o = feed.overlay;
                ws.send(
                    event("overlays.snapshot", {
                        overlay: o,
                        // the runtime page compares this to its own bundled
                        // version and reloads when a new deployment replaced
                        // the server (a restart drops the socket, so the
                        // fresh snapshot on reconnect carries the new stamp)
                        version: APP_VERSION,
                    }),
                );
            },
            message(ws, message) {
                // uplink from the runtime page: an alert went on air and its
                // values must land in the overlay variables
                const overlayId = (ws.data as { overlayId?: string }).overlayId;
                if (!overlayId) return;
                // Elysia pre-parses JSON text frames; socketMessage
                // restores the raw string
                let frame: { event?: string; data?: unknown };
                try {
                    frame = JSON.parse(
                        `${socketMessage(message)}`,
                    ) as { event?: string; data?: unknown };
                } catch {
                    return;
                }
                if (frame.event !== "overlays.applyAlert") return;
                const values = (frame.data as { values?: unknown } | null)
                    ?.values;
                if (
                    typeof values !== "object" ||
                    values === null ||
                    Array.isArray(values)
                )
                    return;
                try {
                    overlays.applyAlertValues(
                        overlayId,
                        values as Record<string, unknown>,
                    );
                } catch {
                    // the values came from this page's own validated
                    // trigger payload; an apply failure means the overlay
                    // changed underneath — the alert already played, there
                    // is nothing safe to surface over a fire-and-forget WS
                }
            },
        });
}
