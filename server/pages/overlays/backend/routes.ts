/*
 * OBS overlay editor routes:
 *   GET  /overlays/                the overlay list page (cookie auth)
 *   GET  /overlays/edit/:id/       the overlay editor page (cookie auth)
 *   GET  /overlay/:id?token=…      the runtime page (owner user-token auth,
 *                                  transparent); <token> is the overlay
 *                                  owner's user token
 *   GET  /overlay/:id/variables?…  revalue variables: ?<name>=<value>…, an
 *                                  empty value clears (owner user-token auth)
 *   POST /overlay/:id/variables?…  revalue variables from a JSON body
 *                                  {<name>: value|null} (owner user-token auth)
 *   GET  /overlay/:id/event/:name?…
 *                                  trigger a universal event on overlay <id>:
 *                                  every trigger-driven element (alerts, spin
 *                                  wheel, …) whose event prop matches <name>
 *                                  reacts; optional ?<name>=<value> pairs ride
 *                                  with the event and land in overlay
 *                                  variables when an element plays it; a
 *                                  name of `path.end/<route>` also renames
 *                                  that overlay's live-map default route to
 *                                  <route> (archiving the segment) (owner
 *                                  user-token auth)
 *   GET  /overlay/:id/map-history?token=…
 *                                  the overlay's live-map route history
 *                                  (JSON: named routes with their recorded
 *                                  GPS points; open routes have endedAt
 *                                  null) (owner user-token auth)
 *   GET  /overlay/:id/files/:fileId?token=…
 *                                  the bytes of an asset-library file an
 *                                  image/video element references
 *                                  (`libraryAssetId`); owner-scoped through
 *                                  the owner's user token (owner user-token
 *                                  auth)
 *   WS   /overlay/:id/ws?token=…   the runtime live feed (owner user-token
 *                                  auth); also accepts the runtime page's
 *                                  `overlays.applyEvent` uplink (it writes
 *                                  an on-air event's values to variables)
 *   POST /api/overlays/:id/duplicate
 *                            copy an overlay (cookie auth); the clone gets a
 *                            fresh id and name
 *   …    /api/overlays…            the editor REST API (cookie auth)
 *
 * The runtime page is what OBS loads as a Browser Source: no session cookie,
 * only the overlay OWNER's user token (chat-overlay pattern), a fully
 * transparent body. The token resolves to a login and the overlay's owner is
 * checked against it, so a token can only reach its owner's overlays.
 */
import { Elysia } from "elysia";
import { APP_VERSION } from "../../../../shared/app_version";
import type { createFrontend } from "../../../../shared/frontend";
import { upgradeRequired } from "../../../../shared/http";
import { socketMessage } from "../../../../shared/socket_message";
import type { PageServices, ProjectAccess } from "../../../core/contracts";
import type { Assets } from "../../assets/server/registry";
import { authenticatedHandler } from "../../../core/auth/authenticated";
import { apiGuard, scopedProject } from "../../../core/project_scope";
import { event } from "../../../core/runtime";
import { ApiError, type Overlays, overlayRuntimeTopic } from "./registry";

type Frontend = Awaited<ReturnType<typeof createFrontend>>;

/** Runs an owner-authenticated store action and maps the outcome: ApiError
 * → JSON `{ok:false, error, code}`, `null` → 404 "Not found" (a probe with a
 * foreign/unknown token must not leak overlay existence, exactly like
 * /overlay/:id). */
type OwnerResult = { status: number; body: Record<string, unknown> } | null;

function ownerJson(
    action: () => OwnerResult | Promise<OwnerResult>,
): Promise<Response> {
    return (async (): Promise<Response> => {
        let result: OwnerResult;
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

/** A wildcard `*` param arrives URL-decoded by the router, so a client-side
 * literal `/` (e.g. `path.end/les` sent as `path.end%2Fles`) needs one
 * more decode; a plain decode throws on stray `%`, so keep the raw value. */
function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

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


export function mountOverlayRoutes(
    routes: Elysia,
    s: PageServices,
    overlays: Overlays,
    assets: Assets,
): void {
    const { auth, capabilities, frontend } = s;
    const access = capabilities.require<ProjectAccess>("projectAccess");

    /** Any member may read a project's overlays; editing needs editor+. */
    const READ_ROLES = ["viewer", "editor", "owner"] as const;
    const EDIT_ROLES = ["editor", "owner"] as const;

    /** Resolve a runtime request's `?token=` to the project id
     * (`auth.projectForToken` maps a device token → project, and to the local
     * project under `--no-auth`); `null` when the token is unknown. The
     * overlay store then checks the id against this project. */
    const runtimeProject = (request: Request): string | null =>
        auth.projectForToken(runtimeToken(request));

    routes
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
            "/overlay/:id/variables",
            ({ request, params }) =>
                ownerJson(() => {
                    const project = runtimeProject(request);
                    if (!project) return null;
                    return overlays.setVariables(
                        project,
                        decodeURIComponent(params.id),
                        queryValues(request),
                    );
                }),
        )
        .post(
            "/overlay/:id/variables",
            ({ request, params }) =>
                ownerJson(async () => {
                    const project = runtimeProject(request);
                    if (!project) return null;
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
                    return overlays.setVariables(
                        project,
                        decodeURIComponent(params.id),
                        body as Record<string, unknown>,
                    );
                }),
        )
        // a wildcard (not `:name`): the event name may carry a path segment
        // of its own — `path.end/<route>` renames the live-map default route
        // to <route> (TODO/09-map.md)
        .get(
            "/overlay/:id/event/*",
            ({ request, params }) =>
                ownerJson(() => {
                    const project = runtimeProject(request);
                    if (!project) return null;
                    // query pairs (if any) set project variables; the
                    // trigger itself is the URL's <name>
                    return overlays.triggerEvent(
                        project,
                        decodeURIComponent(params.id),
                        safeDecodeURIComponent(
                            (params as Record<string, string>)["*"] ?? "",
                        ),
                        queryValues(request),
                    );
                }),
        )
        // Live-map route history (keep_history): the OBS runtime page polls
        // this while a keep_history map element renders active paths.
        .get(
            "/overlay/:id/map-history",
            ({ request, params }) =>
                ownerJson(() => {
                    const project = runtimeProject(request);
                    if (!project) return null;
                    return overlays.mapHistory(
                        project,
                        decodeURIComponent(params.id),
                    );
                }),
        )
        // Media of an image/video element that references the owner's asset
        // library (`libraryAssetId`). Token-scoped like the rest of the
        // runtime: the owner's user token names the overlay's owner, and only
        // that owner's files can be served through it. A bad token, unknown
        // overlay, a foreign overlay, or a file that is not the owner's all
        // 404 (probes must not leak).
        .get(
            "/overlay/:id/files/:fileId",
            ({ request, params }) => {
                const project = runtimeProject(request);
                const feed = project
                    ? overlays.runtimeOverlay(project, decodeURIComponent(params.id))
                    : null;
                if (!feed)
                    return Response.json(
                        { ok: false, error: "Not found", code: 404 },
                        { status: 404 },
                    );
                let file: { mime: string; data: Uint8Array };
                try {
                    const blob = assets.fileBlob(feed.project, params.fileId);
                    file = { mime: blob.file.mimeType, data: blob.data };
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
                return new Response(file.data as BodyInit, {
                    status: 200,
                    headers: {
                        "content-type": file.mime,
                        "content-length": String(file.data.byteLength),
                        ...RUNTIME_HEADERS,
                    },
                });
            },
        )
        .get("/overlay/:id", () => runtimePage(frontend))
        .all(
            "/api/overlays",
            authenticatedHandler(auth, (request, user) =>
                apiGuard(() => {
                    const url = new URL(request.url);
                    const projectId = scopedProject(
                        access,
                        url,
                        user,
                        request.method === "GET" ? READ_ROLES : EDIT_ROLES,
                    );
                    return overlays.api(request, url, projectId);
                }),
            ),
        )
        .all(
            "/api/overlays/*",
            authenticatedHandler(auth, (request, user) =>
                apiGuard(() => {
                    const url = new URL(request.url);
                    const projectId = scopedProject(
                        access,
                        url,
                        user,
                        request.method === "GET" ? READ_ROLES : EDIT_ROLES,
                    );
                    return overlays.api(request, url, projectId);
                }),
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
                const project = auth.projectForToken(runtimeToken(ws.data.request));
                const feed = project
                    ? overlays.runtimeOverlay(project, overlayId)
                    : null;
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
                // uplink from the runtime page: an event went on air and its
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
                if (frame.event !== "overlays.applyEvent") return;
                const values = (frame.data as { values?: unknown } | null)
                    ?.values;
                if (
                    typeof values !== "object" ||
                    values === null ||
                    Array.isArray(values)
                )
                    return;
                try {
                    overlays.applyEventValues(
                        overlayId,
                        values as Record<string, unknown>,
                    );
                } catch {
                    // the values came from this page's own validated
                    // trigger payload; an apply failure means the overlay
                    // changed underneath — the event already played, there
                    // is nothing safe to surface over a fire-and-forget WS
                }
            },
        });
}
