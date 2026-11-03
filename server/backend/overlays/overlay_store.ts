/*
 * OBS overlay editor backend: one row per overlay in the `overlays` table,
 * persisted as a JSON blob (the `dashboards.widgets` precedent). An overlay is
 * self-contained — its own canvas, variables, assets, elements and token.
 * Mutations go over REST (`/api/overlays…`, handled by `Overlays.api`) and fan
 * out to:
 *   - the editor live feed (the shared `dashboards:<owner>` topic), and
 *   - the runtime feed (`overlay-runtime:<overlayId>`, now keyed per overlay)
 *     consumed by the token-authenticated OBS runtime pages (their WS is wired
 *     in overlay_routes.ts).
 *
 * Runtime pages authenticate with the overlay's token (chat-overlay pattern:
 * `?token=…`, constant-time compare) — no cookie, because a Browser Source has
 * no session.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
    type Asset,
    defaultOverlay,
    generateOverlayToken,
    isAcceptedAssetMime,
    migrateOverlayBlob,
    normalizeOverlay,
    OVERLAY_LIMITS,
    OVERLAY_SCHEMA_VERSION,
    type Overlay,
    type OverlayElement,
    overlayTokenMatches,
    parseCanvasInput,
    parseElementInput,
    parseOverlayInput,
    parseVariableValueInput,
    type Variable,
} from "../../../shared/overlay";
import { overlayElementSchema } from "../../../shared/overlay_elements";
import { event, overlayRuntimeTopic, type Publish } from "../contracts";
export { overlayRuntimeTopic };

// single ApiError class shared with shared/overlay.ts so `instanceof`
// classification (400 vs 500) works across the module boundary
export { ApiError } from "../../../shared/params";

import { ApiError } from "../../../shared/params";

interface Store {
    id: string;
    owner: string;
    overlay: Overlay;
    token: string;
    updatedAt: number;
}

/** Lightweight row the list page renders (no element/variable payloads). */
export interface OverlaySummary {
    id: string;
    name: string;
    token: string;
    elementCount: number;
    updatedAt: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_TYPES: Variable["type"][] = [
    "string",
    "number",
    "boolean",
    "color",
];

export interface RuntimeOverlay {
    /** The overlay's owner (kept so the WS uplink can address the store). */
    owner: string;
    overlay: Overlay;
}

export interface Overlays {
    api(req: Request, url: URL, user: string): Promise<Response>;
    /** A user's overlays (lightweight, list-page shape). */
    overlaysFor(user: string): OverlaySummary[];
    /**
     * The full overlay an OBS runtime page renders, resolved from its token +
     * id; `null` when the token is unknown or does not own an overlay with that
     * id (token probes must not leak existence, same as the runtime page).
     */
    runtimeOverlay(token: string, overlayId: string): RuntimeOverlay | null;
    /**
     * The channel specs an overlay's chat elements display, resolved from the
     * overlay's token + id; `null` when the token is unknown or does not own an
     * overlay with that id. Used by the standalone chat overlay WebSocket to
     * know which providers to keep attached.
     */
    runtimeOverlayChatSpecs(token: string, overlayId: string): string[] | null;
    /**
     * Token-authenticated batch revalue for the variables endpoint
     * (`GET /overlay/variables?token=…&<name>=<value>…` and
     * `POST /overlay/variables?token=…` with a JSON `{<name>: value|null}`
     * body). `values` maps variable name → raw value; `null`/`""` empties the
     * variable to its type's neutral value. The whole batch lands in one commit
     * and one `overlays.overlay` frame. `null` when the token is unknown (the
     * route 404s — token probes must not leak overlay existence); an empty
     * batch, an unknown name, or a bad value throws ApiError(404/400).
     */
    setVariablesByToken(
        token: string,
        values: Record<string, unknown>,
    ): { status: number; body: Record<string, unknown> } | null;
    /**
     * Token-authenticated alert trigger for
     * `GET /overlay/alert/<name>?token=…&<name>=<value>…`: publishes an
     * `overlays.alert` frame (`{name, payload}`) on the overlay's runtime
     * topic; the runtime page shows every alert element whose `event` prop
     * equals `name`. Any query values are validated and type-coerced and ride
     * along in `payload` — the runtime page writes them into the overlay
     * variables (the `overlays.applyAlert` WS uplink → `applyAlertValues`) only
     * when that alert goes on air. `null` when the token is unknown; `name` is
     * not validated against overlay state (it just needs to match an element on
     * the client).
     */
    triggerAlertByToken(
        token: string,
        name: string,
        values: Record<string, unknown>,
    ): { status: number; body: Record<string, unknown> } | null;
    /**
     * The runtime page's `overlays.applyAlert` WS uplink: writes an on-air
     * alert's payload values into the overlay variables (one commit + one
     * `overlays.overlay` frame). Only reachable from a runtime WS whose open
     * already passed the token+overlay check. `false` on unknown overlay.
     */
    applyAlertValues(overlayId: string, values: Record<string, unknown>): boolean;
}

export function createOverlays({
    db,
    databaseFile,
    publish,
}: {
    db: Database | null;
    databaseFile: string;
    publish: Publish;
}): Overlays {
    const DB_FILE = databaseFile;
    // one entry per overlay (key = overlay id); each carries its own token
    const stores = new Map<string, Store>();

    function persist(store: Store): void {
        if (!db) return;
        try {
            db.prepare(
                `INSERT INTO overlays (id, owner, schema_version, data, token, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     owner = excluded.owner,
                     schema_version = excluded.schema_version,
                     data = excluded.data,
                     token = excluded.token,
                     updated_at = excluded.updated_at`,
            ).run(
                store.id,
                store.owner,
                OVERLAY_SCHEMA_VERSION,
                JSON.stringify(store.overlay),
                store.token,
                store.updatedAt,
            );
        } catch (err: unknown) {
            console.error(`[overlays] persist ${DB_FILE}:`, err);
        }
    }

    /** Remove an overlay's row (the in-memory removal is done by the caller). */
    function prune(id: string): void {
        if (!db) return;
        try {
            db.prepare("DELETE FROM overlays WHERE id = ?").run(id);
        } catch (err: unknown) {
            console.error(`[overlays] prune ${DB_FILE}:`, err);
        }
    }

    /** One-time migration from the legacy `overlay_projects` table (one project
     * per user, `scenes[]` inside). Splits each project into one overlay per
     * scene (the scene's elements promote to the overlay root), each with a
     * fresh token, then drops the legacy table (no backward compatibility). */
    function backfillFromLegacy(): void {
        if (!db) return;
        const hasLegacy = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='overlay_projects'",
            )
            .get() as { name: string } | null;
        if (!hasLegacy) return;
        const overlayCount = (
            db.prepare("SELECT count(*) c FROM overlays").get() as { c: number }
        ).c;
        if (overlayCount > 0) {
            // already migrated (e.g. a restart) — just retire the legacy table
            db.exec("DROP TABLE overlay_projects");
            return;
        }
        const rows = db
            .prepare("SELECT owner, data FROM overlay_projects")
            .all() as { owner: string; data: string }[];
        const insert = db.prepare(
            "INSERT INTO overlays (id, owner, schema_version, data, token, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const row of rows) {
            let project: Record<string, unknown>;
            try {
                project = JSON.parse(row.data);
            } catch {
                continue;
            }
            const canvas = isRecord(project.canvas)
                ? project.canvas
                : { width: 1920, height: 1080 };
            const variables = Array.isArray(project.variables)
                ? project.variables
                : [];
            const assets = Array.isArray(project.assets) ? project.assets : [];
            const scenes = Array.isArray(project.scenes) ? project.scenes : [];
            const list: Record<string, unknown>[] = scenes.length
                ? (scenes as Record<string, unknown>[])
                : [{ name: "Overlay 1", elements: [] }];
            for (const sc of list) {
                try {
                    const overlay = normalizeOverlay({
                        schemaVersion: OVERLAY_SCHEMA_VERSION,
                        name:
                            typeof sc.name === "string" && sc.name
                                ? sc.name
                                : "Overlay",
                        canvas,
                        variables,
                        assets,
                        elements: Array.isArray(sc.elements) ? sc.elements : [],
                    });
                    insert.run(
                        randomUUID(),
                        row.owner,
                        OVERLAY_SCHEMA_VERSION,
                        JSON.stringify(overlay),
                        generateOverlayToken(),
                        Date.now(),
                    );
                } catch (err: unknown) {
                    console.warn(
                        `[overlays] dropping a legacy scene on backfill to ${row.owner}:`,
                        err instanceof Error ? err.message : err,
                    );
                }
            }
        }
        db.exec("DROP TABLE overlay_projects");
    }

    function load(): void {
        if (!db) return;
        backfillFromLegacy();
        const rows = db
            .prepare("SELECT id, owner, data, token, updated_at FROM overlays")
            .all() as {
            id: string;
            owner: string;
            data: string;
            token: string;
            updated_at: number;
        }[];
        for (const row of rows) {
            try {
                const { overlay } = migrateOverlayBlob(JSON.parse(row.data));
                stores.set(row.id, {
                    id: row.id,
                    owner: row.owner,
                    overlay,
                    token: row.token,
                    updatedAt: row.updated_at,
                });
            } catch (err: unknown) {
                console.warn(
                    `[overlays] dropping unmigratable overlay ${row.id}:`,
                    err instanceof Error ? err.message : err,
                );
            }
        }
    }
    load();

    const summary = (s: Store): OverlaySummary => ({
        id: s.id,
        name: s.overlay.name,
        token: s.token,
        elementCount: s.overlay.elements.length,
        updatedAt: s.updatedAt,
    });

    const overlaysFor = (owner: string): OverlaySummary[] =>
        [...stores.values()]
            .filter((s) => s.owner === owner)
            .sort((a, b) => a.updatedAt - b.updatedAt)
            .map(summary);

    const storeWithOwner = (owner: string, id: string): Store => {
        const store = stores.get(id);
        if (!store || store.owner !== owner)
            throw new ApiError("Unknown overlay", 404);
        return store;
    };

    /** Re-validate the whole overlay (cross references included). On a failure
     * the in-memory overlay is rolled back to its pre-call state so a rejected
     * mutation can't wedge the store, and the raw validation Error is raised as
     * a 400 so API clients see the reason instead of a 500. */
    const revalidate = (overlay: Overlay): void => {
        const snapshot = JSON.stringify(overlay);
        try {
            normalizeOverlay(overlay as unknown as Record<string, unknown>);
        } catch (e) {
            try {
                Object.assign(overlay, JSON.parse(snapshot));
            } catch {
                // best effort only — the throw below is what matters
            }
            throw new ApiError(
                e instanceof Error ? e.message : "overlay is invalid",
                400,
            );
        }
    };

    const commit = (store: Store): void => {
        store.updatedAt = Date.now();
        persist(store);
    };

    // ── event fan-out ────────────────────────────────────────────────────
    /** Editor feed: shared per-owner topic (the overlays editor + dashboards
     * both listen; each page filters frames it doesn't own). */
    const feed = (owner: string, name: string, data: unknown): void => {
        publish(`dashboards:${owner}`, event(name, data));
    };
    /** Runtime feed: keyed per overlay id so one user's overlays don't feed
     * each other's OBS pages. */
    const runtime = (overlayId: string, name: string, data: unknown): void => {
        publish(overlayRuntimeTopic(overlayId), event(name, data));
    };
    /** Refresh the owner's list page (names, counts, tokens). */
    const feedList = (owner: string): void => {
        feed(owner, "overlays.overlays", { overlays: overlaysFor(owner) });
    };
    /** Push one overlay's full state to its editor and its runtime page. The
     * editor feed is a per-owner topic serving every overlay at once, so the
     * frame carries `overlayId` (the runtime topic is already per-overlay, but
     * keeps the same shape). */
    const feedOverlay = (store: Store): void => {
        feed(store.owner, "overlays.overlay", {
            overlayId: store.id,
            overlay: store.overlay,
        });
        runtime(store.id, "overlays.overlay", {
            overlayId: store.id,
            overlay: store.overlay,
        });
    };

    // ── REST API ─────────────────────────────────────────────────────────
    const notAllowed = (): Response =>
        Response.json(
            { ok: false, error: "Method not allowed", code: 405 },
            { status: 405 },
        );

    /** Create a fresh overlay for `owner` and persist it. */
    function createOverlay(owner: string, name: string): Store {
        if (overlaysFor(owner).length >= OVERLAY_LIMITS.overlaysMax)
            throw new ApiError("Too many overlays");
        const store: Store = {
            id: randomUUID(),
            owner,
            overlay: defaultOverlay(name),
            token: generateOverlayToken(),
            updatedAt: Date.now(),
        };
        stores.set(store.id, store);
        commit(store);
        feedList(owner);
        feedOverlay(store);
        return store;
    }

    /** Apply a `{name?, elements?}` patch to one overlay, validate, persist,
     * fan out. */
    function patchOverlay(
        owner: string,
        id: string,
        patch: { name?: string; elements?: OverlayElement[] },
    ): Store {
        const store = storeWithOwner(owner, id);
        if (patch.name !== undefined) store.overlay.name = patch.name;
        if (patch.elements !== undefined) {
            store.overlay.elements = patch.elements;
            // Monotonic counter so editors can drop stale (out-of-order) WS
            // broadcasts that predate the freshest state they already applied.
            store.overlay.rev = (store.overlay.rev ?? 0) + 1;
        }
        revalidate(store.overlay);
        commit(store);
        feedList(owner);
        feedOverlay(store);
        return store;
    }

    async function api(
        req: Request,
        url: URL,
        user: string,
    ): Promise<Response> {
        try {
            const m = url.pathname.match(
                /^\/api\/overlays(\/([\w.-]{1,64})(?:\/(variables|assets|token|canvas|elements|duplicate)(?:\/([\w.-]{1,64})?)?)?)?$/,
            );
            if (!m)
                return Response.json(
                    { ok: false, error: "Not found", code: 404 },
                    { status: 404 },
                );
            const id = m[2] as string | undefined;
            const sub = (m[3] as
                | "variables"
                | "assets"
                | "token"
                | "canvas"
                | "elements"
                | "duplicate"
                | undefined) ?? null;
            const subId = m[4] as string | undefined;

            // ── collection: /api/overlays ────────────────────────────────
            if (!id) {
                if (req.method === "GET")
                    return Response.json({ ok: true, overlays: overlaysFor(user) });
                if (req.method === "POST") {
                    const body = (await req.json().catch(() => ({}))) as {
                        name?: unknown;
                    };
                    const name =
                        typeof body.name === "string" && body.name.trim()
                            ? body.name.trim().slice(0, OVERLAY_LIMITS.nameMax)
                            : "Overlay";
                    const store = createOverlay(user, name);
                    return Response.json(
                        { ok: true, id: store.id, token: store.token, overlay: store.overlay },
                        { status: 201 },
                    );
                }
                return notAllowed();
            }

            // ── one overlay: /api/overlays/:id ───────────────────────────
            if (!sub) {
                if (req.method === "GET") {
                    const store = storeWithOwner(user, id);
                    return Response.json({
                        ok: true,
                        id: store.id,
                        token: store.token,
                        overlay: store.overlay,
                    });
                }
                if (req.method === "PUT") {
                    const body = (await req.json()) as {
                        name?: unknown;
                        elements?: unknown;
                    };
                    const patch = parseOverlayInput(body);
                    if (body.name !== undefined && !patch.name)
                        throw new ApiError("overlay name is empty");
                    const store = patchOverlay(user, id, patch);
                    return Response.json({ ok: true, overlay: store.overlay });
                }
                if (req.method === "DELETE") {
                    storeWithOwner(user, id);
                    stores.delete(id);
                    prune(id);
                    feedList(user);
                    return Response.json({ ok: true });
                }
                return notAllowed();
            }

            // ── sub-resources under /api/overlays/:id/… ──────────────────
            if (sub === "duplicate") {
                if (req.method !== "POST") return notAllowed();
                if (overlaysFor(user).length >= OVERLAY_LIMITS.overlaysMax)
                    throw new ApiError("Too many overlays");
                const source = storeWithOwner(user, id);
                // a copy is a fresh overlay: clone the source, rename it, drop
                // its server-managed rev
                const copy = JSON.parse(
                    JSON.stringify(source.overlay),
                ) as Overlay;
                copy.name = `${source.overlay.name} (copy)`.slice(
                    0,
                    OVERLAY_LIMITS.nameMax,
                );
                copy.rev = undefined;
                const store: Store = {
                    id: randomUUID(),
                    owner: user,
                    overlay: copy,
                    token: generateOverlayToken(),
                    updatedAt: Date.now(),
                };
                revalidate(store.overlay);
                stores.set(store.id, store);
                commit(store);
                feedList(user);
                feedOverlay(store);
                return Response.json(
                    { ok: true, id: store.id, token: store.token, overlay: store.overlay },
                    { status: 201 },
                );
            }

            if (sub === "canvas") {
                if (req.method !== "PUT") return notAllowed();
                const body = (await req.json()) as { canvas?: unknown };
                const canvas = parseCanvasInput(body.canvas);
                const store = storeWithOwner(user, id);
                store.overlay.canvas = canvas;
                revalidate(store.overlay);
                commit(store);
                feedOverlay(store);
                return Response.json({ ok: true, canvas });
            }

            if (sub === "elements") {
                if (req.method === "PUT" && !subId) {
                    const body = (await req.json()) as { element?: unknown };
                    if (!isRecord(body.element))
                        throw new ApiError("element is required");
                    const element = parseElementInput(body.element);
                    const store = storeWithOwner(user, id);
                    // checked up front so a stale binding fails with a 400
                    // naming the problem, not a 500 deep in revalidate
                    if (
                        Object.values(element.bindings ?? {}).some(
                            (b) =>
                                !store.overlay.variables.some(
                                    (v) => v.id === b.variableId,
                                ),
                        )
                    )
                        throw new ApiError(
                            "element binds to an unknown variable",
                        );
                    const i = store.overlay.elements.findIndex(
                        (e) => e.id === element.id,
                    );
                    if (i >= 0) store.overlay.elements[i] = element;
                    else store.overlay.elements.push(element);
                    store.overlay.rev = (store.overlay.rev ?? 0) + 1;
                    revalidate(store.overlay);
                    commit(store);
                    feedList(user);
                    feedOverlay(store);
                    return Response.json({ ok: true, overlay: store.overlay });
                }
                if (req.method === "DELETE" && subId) {
                    const store = storeWithOwner(user, id);
                    const i = store.overlay.elements.findIndex(
                        (e) => e.id === subId,
                    );
                    if (i < 0) throw new ApiError("Unknown element", 404);
                    // re-parent children of a deleted group
                    store.overlay.elements = store.overlay.elements
                        .filter((e) => e.id !== subId)
                        .map((e) =>
                            e.parentId === subId ? { ...e, parentId: null } : e,
                        );
                    store.overlay.rev = (store.overlay.rev ?? 0) + 1;
                    revalidate(store.overlay);
                    commit(store);
                    feedList(user);
                    feedOverlay(store);
                    return Response.json({ ok: true, overlay: store.overlay });
                }
                return notAllowed();
            }

            if (sub === "variables") {
                if (req.method === "POST" && !subId) {
                    const body = (await req.json()) as {
                        name?: unknown;
                        type?: unknown;
                        value?: unknown;
                    };
                    const store = storeWithOwner(user, id);
                    if (
                        store.overlay.variables.length >=
                        OVERLAY_LIMITS.variablesMax
                    )
                        throw new ApiError("Too many variables");
                    const name =
                        typeof body.name === "string" ? body.name.trim() : "";
                    if (
                        !NAME_RE.test(name) ||
                        store.overlay.variables.some((v) => v.name === name)
                    )
                        throw new ApiError(
                            "Variable needs a unique name [a-zA-Z_][a-zA-Z0-9_]*",
                        );
                    const type: Variable["type"] = VALID_TYPES.includes(
                        body.type as Variable["type"],
                    )
                        ? (body.type as Variable["type"])
                        : "string";
                    let value: string | number | boolean;
                    if (body.value !== undefined)
                        value = parseVariableValueInput(body.value, {
                            id: "",
                            name,
                            type,
                            value: "",
                        });
                    else
                        value =
                            type === "number"
                                ? 0
                                : type === "boolean"
                                  ? false
                                  : type === "color"
                                    ? "#ffffff"
                                    : "";
                    const variable: Variable = {
                        id: randomUUID(),
                        name,
                        type,
                        value,
                    };
                    store.overlay.variables.push(variable);
                    revalidate(store.overlay);
                    commit(store);
                    feedOverlay(store);
                    return Response.json(
                        { ok: true, variable },
                        { status: 201 },
                    );
                }
                if (req.method === "PUT" && subId) {
                    const body = (await req.json()) as {
                        name?: unknown;
                        type?: unknown;
                        value?: unknown;
                    };
                    const store = storeWithOwner(user, id);
                    const variable = store.overlay.variables.find(
                        (v) => v.id === subId,
                    );
                    if (!variable) throw new ApiError("Unknown variable", 404);
                    if (body.name !== undefined) {
                        const name =
                            typeof body.name === "string"
                                ? body.name.trim()
                                : "";
                        if (
                            !NAME_RE.test(name) ||
                            store.overlay.variables.some(
                                (v) => v.name === name && v.id !== subId,
                            )
                        )
                            throw new ApiError("Invalid or duplicate name");
                        variable.name = name;
                    }
                    if (
                        body.type !== undefined &&
                        body.type !== variable.type
                    ) {
                        if (
                            !VALID_TYPES.includes(body.type as Variable["type"])
                        )
                            throw new ApiError("Invalid type");
                        variable.type = body.type as Variable["type"];
                    }
                    if (body.value !== undefined)
                        variable.value = parseVariableValueInput(
                            body.value,
                            variable,
                        );
                    revalidate(store.overlay);
                    commit(store);
                    feedOverlay(store);
                    return Response.json({ ok: true, variable });
                }
                if (req.method === "DELETE" && subId) {
                    const store = storeWithOwner(user, id);
                    const before = store.overlay.variables.length;
                    store.overlay.variables = store.overlay.variables.filter(
                        (v) => v.id !== subId,
                    );
                    if (store.overlay.variables.length === before)
                        throw new ApiError("Unknown variable", 404);
                    // drop bindings to the removed variable
                    for (const e of store.overlay.elements)
                        for (const [k, b] of Object.entries(e.bindings))
                            if (b.variableId === subId) delete e.bindings[k];
                    revalidate(store.overlay);
                    commit(store);
                    feedOverlay(store);
                    return Response.json({ ok: true });
                }
                return notAllowed();
            }

            if (sub === "assets") {
                if (req.method === "POST" && !subId) {
                    const body = (await req.json()) as {
                        filename?: unknown;
                        mime?: unknown;
                        dataBase64?: unknown;
                    };
                    const filename =
                        typeof body.filename === "string" && body.filename
                            ? body.filename.slice(0, 255)
                            : "asset";
                    const mime =
                        typeof body.mime === "string" &&
                        isAcceptedAssetMime(body.mime)
                            ? body.mime
                            : null;
                    const dataBase64 =
                        typeof body.dataBase64 === "string"
                            ? body.dataBase64
                            : null;
                    if (!mime || !dataBase64)
                        throw new ApiError(
                            "Asset needs filename, an image/video/audio mime and base64 data",
                        );
                    if (dataBase64.length > OVERLAY_LIMITS.assetBase64Max)
                        throw new ApiError("Asset is too large");
                    const store = storeWithOwner(user, id);
                    if (
                        store.overlay.assets.length >= OVERLAY_LIMITS.assetsMax
                    )
                        throw new ApiError("Too many assets");
                    const hash = createHash("sha256")
                        .update(Buffer.from(dataBase64, "base64"))
                        .digest("hex");
                    let asset = store.overlay.assets.find(
                        (a) => a.hash === hash,
                    );
                    if (!asset) {
                        asset = {
                            id: randomUUID(),
                            hash,
                            mime,
                            filename,
                            dataBase64,
                        };
                        store.overlay.assets.push(asset);
                    }
                    commit(store);
                    feedOverlay(store);
                    return Response.json(
                        { ok: true, asset },
                        { status: 201 },
                    );
                }
                if (req.method === "DELETE" && subId) {
                    const store = storeWithOwner(user, id);
                    const before = store.overlay.assets.length;
                    store.overlay.assets = store.overlay.assets.filter(
                        (a) => a.id !== subId,
                    );
                    if (store.overlay.assets.length === before)
                        throw new ApiError("Unknown asset", 404);
                    // elements referencing it (their schema's assetProps) fall
                    // back to an empty box
                    for (const e of store.overlay.elements)
                        for (const key of overlayElementSchema(e.type)
                            ?.assetProps ?? [])
                            if (e.props[key] === subId) e.props[key] = "";
                    revalidate(store.overlay);
                    commit(store);
                    feedOverlay(store);
                    return Response.json({ ok: true });
                }
                return notAllowed();
            }

            if (sub === "token") {
                if (req.method === "POST" && subId === "rotate") {
                    const store = storeWithOwner(user, id);
                    store.token = generateOverlayToken();
                    commit(store);
                    feedList(user);
                    feed(store.owner, "overlays.token", {
                        overlayId: store.id,
                        token: store.token,
                    });
                    return Response.json({ ok: true, token: store.token });
                }
                return notAllowed();
            }

            return notAllowed();
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
    }

    // ── runtime access (token-authenticated, no user session) ────────────
    function runtimeStore(token: string): Store | null {
        for (const s of stores.values())
            if (overlayTokenMatches(s.token, token)) return s;
        return null;
    }

    /** Validate + type-coerce a value batch against the overlay's variables
     * WITHOUT mutating: unknown names 404, null/"" → the type's neutral value,
     * booleans map "true"/"false"/"0"/"1", numbers parse (the
     * variables-endpoint rules). Returns the resolved `{name: coercedValue}`
     * pairs. Shared by the variables endpoint (which then applies the result)
     * and the alert trigger endpoint (which ships the result with the frame). */
    function resolveTokenValues(
        store: Store,
        values: Record<string, unknown>,
    ): Record<string, unknown> {
        const resolved: Record<string, unknown> = {};
        // names are unique per overlay, so the token endpoint keys on names
        // (ids are internal, names are what triggers match on)
        for (const name of Object.keys(values)) {
            const variable = store.overlay.variables.find(
                (v) => v.name === name,
            );
            if (!variable) throw new ApiError("Unknown variable", 404);
            const raw = values[name];
            // null/"" clears: the type's neutral empty value
            if (raw === null || raw === undefined || raw === "") {
                resolved[name] =
                    variable.type === "number"
                        ? 0
                        : variable.type === "boolean"
                          ? false
                          : variable.type === "color"
                            ? "#000000"
                            : "";
                continue;
            }
            // querystring values are strings; map "true"/"false" onto
            // boolean variables (the parser's !!truthy would turn
            // "false" into true)
            let value: unknown = raw;
            if (variable.type === "boolean" && typeof raw === "string") {
                const s = raw.trim().toLowerCase();
                if (s === "true" || s === "1") value = true;
                else if (s === "false" || s === "0") value = false;
                else throw new ApiError(`${variable.name} must be true or false`);
            }
            resolved[name] = parseVariableValueInput(value, variable);
        }
        return resolved;
    }

    /** Apply a token-endpoint value batch to the overlay variables in place
     * (validate+coerce via `resolveTokenValues` first, so a bad value throws
     * before any value is applied). */
    function applyTokenValues(store: Store, values: Record<string, unknown>): void {
        const resolved = resolveTokenValues(store, values);
        for (const [name, value] of Object.entries(resolved)) {
            const variable = store.overlay.variables.find(
                (v) => v.name === name,
            );
            // resolveTokenValues just validated every name and coerced each
            // value to the variable's type — the find can't fail
            if (variable) variable.value = value as Variable["value"];
        }
    }

    function setVariablesByToken(
        token: string,
        values: Record<string, unknown>,
    ): { status: number; body: Record<string, unknown> } | null {
        const store = runtimeStore(token);
        if (!store) return null;
        if (Object.keys(values).length === 0)
            throw new ApiError("at least one variable is required", 400);
        applyTokenValues(store, values);
        // one commit + one frame for the whole batch, so a live overlay sees
        // all the new values in a single render
        try {
            revalidate(store.overlay);
        } catch {
            // a revalidation failure here means internal cross-references are
            // off in a way the caller can't have caused — keep the endpoint's
            // no-leak contract (bare 404, like an unknown variable)
            throw new ApiError("Not found", 404);
        }
        commit(store);
        feedOverlay(store);
        return {
            status: 200,
            body: { ok: true, variables: store.overlay.variables },
        };
    }

    /** Trigger an alert through its event name (the `<name>` in
     * `GET /overlay/alert/<name>`): the event is pushed to the overlay's
     * runtime topic as an `overlays.alert` frame. Any query values are
     * validated + type-coerced and shipped in the frame's `payload` — the
     * runtime page applies them to same-named overlay variables (via the
     * `overlays.applyAlert` WS uplink → `applyAlertValues`) only when that
     * alert goes on air, so a queued alert's values never clobber the on-air
     * ones early (and they persist once written). `null` when the token is
     * unknown (the route 404s, same no-leak contract as the variables
     * endpoint); unknown variable names and bad values throw ApiError. */
    function triggerAlertByToken(
        token: string,
        name: string,
        values: Record<string, unknown>,
    ): { status: number; body: Record<string, unknown> } | null {
        const store = runtimeStore(token);
        if (!store) return null;
        // validate + coerce without touching the overlay: the values travel
        // with the alert and land when it plays
        const payload = resolveTokenValues(store, values);
        runtime(store.id, "overlays.alert", { name, payload });
        return { status: 200, body: { ok: true, name } };
    }

    /** The runtime page's `overlays.applyAlert` WS uplink: writes an on-air
     * alert's payload values into the overlay variables (one commit + one
     * `overlays.overlay` frame). Only reachable from a runtime WS whose `open`
     * already passed the token+overlay check. Returns `false` on unknown
     * overlay; unknown variable names still throw (they can't have come from a
     * validated trigger frame in the first place). */
    function applyAlertValues(
        overlayId: string,
        values: Record<string, unknown>,
    ): boolean {
        const store = stores.get(overlayId);
        if (!store || Object.keys(values).length === 0) return false;
        applyTokenValues(store, values);
        try {
            revalidate(store.overlay);
        } catch {
            // overlay binding lost against the variable set — surface it (the
            // runtime WS is an authenticated internal client)
            throw new ApiError(
                "overlay validation failed after applying alert values",
                500,
            );
        }
        commit(store);
        feedOverlay(store);
        return true;
    }

    return {
        api,
        overlaysFor,
        runtimeOverlay: (
            token: string,
            overlayId: string,
        ): RuntimeOverlay | null => {
            const store = runtimeStore(token);
            if (!store || store.id !== overlayId) return null;
            return { owner: store.owner, overlay: store.overlay };
        },
        runtimeOverlayChatSpecs: (
            token: string,
            overlayId: string,
        ): string[] | null => {
            const store = runtimeStore(token);
            if (!store || store.id !== overlayId) return null;
            const specs = new Set<string>();
            for (const el of store.overlay.elements) {
                if (el.type !== "chat") continue;
                // `props.channels` is already normalized by the chat schema
                // (a clean `{platform, channel}[]`), so it can be mapped to
                // specs without re-importing the chat module.
                const channels = el.props?.channels;
                if (!Array.isArray(channels)) continue;
                for (const c of channels) {
                    if (
                        typeof c === "object" &&
                        c !== null &&
                        typeof c.platform === "string" &&
                        typeof c.channel === "string" &&
                        c.channel
                    )
                        specs.add(`${c.platform}:${c.channel}`);
                }
            }
            return [...specs];
        },
        setVariablesByToken,
        triggerAlertByToken,
        applyAlertValues,
    };
}
