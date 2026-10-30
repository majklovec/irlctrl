/*
 * OBS overlay editor backend: one overlay project per user, persisted as a
 * JSON blob (the `dashboards.widgets` precedent). Mutations go over REST
 * (`/api/overlays…`, handled by `OverlayApi.api`) and fan out to:
 *   - the editor live feed (the shared `dashboards:<user>` topic), and
 *   - the runtime feed (`overlay-runtime:<user>`) consumed by the
 *     token-authenticated OBS runtime pages (their WS is wired in
 *     plugins/overlays.ts).
 *
 * Runtime pages authenticate with the project token (chat-overlay pattern:
 * `?token=…`, constant-time compare) — no cookie, because a Browser Source
 * has no session.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
    type Asset,
    defaultProject,
    generateOverlayToken,
    migrateProjectBlob,
    normalizeProject,
    OVERLAY_LIMITS,
    OVERLAY_SCHEMA_VERSION,
    type OverlayElement,
    type OverlayProject,
    overlayTokenMatches,
    parseCanvasInput,
    parseElementInput,
    parseSceneInput,
    parseVariableValueInput,
    type Scene,
    type Variable,
} from "../../shared/overlay";
import { event, type Publish } from "./contracts";

// single ApiError class shared with shared/overlay.ts so `instanceof`
// classification (400 vs 500) works across the module boundary
export { ApiError } from "../../shared/params";

import { ApiError } from "../../shared/params";

interface Store {
    project: OverlayProject;
    token: string;
    updatedAt: number;
}

/** Runtime feed topic: one per project (== owner). */
export const overlayRuntimeTopic = (user: string) => `overlay-runtime:${user}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_TYPES: Variable["type"][] = [
    "string",
    "number",
    "boolean",
    "color",
];

export interface RuntimeScene {
    user: string;
    scene: Scene;
    variables: Variable[];
    canvas: { width: number; height: number };
    assets: Asset[];
}

export interface Overlays {
    api(req: Request, url: URL, user: string): Promise<Response>;
    /** The current project of `user` (default project on first access). */
    projectFor(user: string): OverlayProject;
    /**
     * Runtime feed payload for a token + scene slug, `null` when the token
     * is unknown or does not own a scene with that slug.
     */
    runtimeScene(token: string, slug: string): RuntimeScene | null;
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
    const stores = new Map<string, Store>();

    function persist(owner: string, store: Store): void {
        if (!db) return;
        try {
            db.prepare(
                `INSERT INTO overlay_projects (id, owner, schema_version, data, token, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     schema_version = excluded.schema_version,
                     data = excluded.data,
                     token = excluded.token,
                     updated_at = excluded.updated_at`,
            ).run(
                owner,
                owner,
                OVERLAY_SCHEMA_VERSION,
                JSON.stringify(store.project),
                store.token,
                store.updatedAt,
            );
        } catch (err: unknown) {
            console.error(`[overlays] persist ${DB_FILE}:`, err);
        }
    }

    function load(): void {
        if (!db) return;
        const rows: {
            owner: string;
            data: string;
            token: string;
            updated_at: number;
        }[] = db
            .prepare("SELECT owner, data, token, updated_at FROM overlay_projects")
            .all() as {
            owner: string;
            data: string;
            token: string;
            updated_at: number;
        }[];
        for (const row of rows) {
            try {
                const { project } = migrateProjectBlob(JSON.parse(row.data));
                stores.set(row.owner, {
                    project,
                    token: row.token,
                    updatedAt: row.updated_at,
                });
            } catch (err: unknown) {
                console.warn(
                    `[overlays] dropping unmigratable project of ${row.owner}:`,
                    err instanceof Error ? err.message : err,
                );
            }
        }
    }
    load();

    function storeFor(owner: string): Store {
        let store = stores.get(owner);
        if (!store) {
            store = {
                project: defaultProject(),
                token: generateOverlayToken(),
                updatedAt: Date.now(),
            };
            stores.set(owner, store);
            persist(owner, store);
        }
        return store;
    }

    /** Re-validate the whole project (cross references included). */
    const revalidate = (project: OverlayProject): void => {
        normalizeProject(project as unknown as Record<string, unknown>);
    };

    const commit = (owner: string, store: Store): void => {
        store.updatedAt = Date.now();
        persist(owner, store);
    };

    // ── event fan-out ────────────────────────────────────────────────────
    const feed = (user: string, name: string, data: unknown): void => {
        publish(`dashboards:${user}`, event(name, data));
    };
    const runtime = (user: string, name: string, data: unknown): void => {
        publish(overlayRuntimeTopic(user), event(name, data));
    };

    // ── scene helpers ────────────────────────────────────────────────────
    const findScene = (project: OverlayProject, sceneId: string): Scene => {
        const scene = project.scenes.find((s) => s.id === sceneId);
        if (!scene) throw new ApiError("Unknown scene", 404);
        return scene;
    };

    const uniqueSlug = (project: OverlayProject): string => {
        const used = new Set(project.scenes.map((s) => s.slug));
        let i = 1;
        while (used.has(`scene-${i}`)) i++;
        return `scene-${i}`;
    };

    const applyScenePatch = (
        project: OverlayProject,
        scene: Scene,
        patch: { name?: string; slug?: string; elements?: OverlayElement[] },
    ): void => {
        if (patch.name !== undefined) scene.name = patch.name;
        if (patch.slug !== undefined) scene.slug = patch.slug;
        if (patch.elements !== undefined) scene.elements = patch.elements;
        if (project.scenes.some((s) => s.slug === scene.slug && s.id !== scene.id))
            throw new ApiError(`slug ${scene.slug} is already used`);
        revalidate(project);
    };

    /**
     * Mutate one scene, validate the project, persist, and fan the scene out
     * to the editor feed and the runtime feed.
     */
    const mutateScene = (
        owner: string,
        sceneId: string,
        fn: (scene: Scene) => void,
    ): Scene => {
        const store = stores.get(owner);
        if (!store) throw new ApiError("Unknown scene", 404);
        const scene = findScene(store.project, sceneId);
        fn(scene);
        revalidate(store.project);
        commit(owner, store);
        feed(owner, "overlays.scene", { scene });
        runtime(owner, "overlays.scene", { scene });
        return scene;
    };

    // ── REST API ─────────────────────────────────────────────────────────
    const notAllowed = (): Response =>
        Response.json(
            { ok: false, error: "Method not allowed", code: 405 },
            { status: 405 },
        );

    async function api(req: Request, url: URL, user: string): Promise<Response> {
        try {
            const m = url.pathname.match(
                /^\/api\/overlays$|^\/api\/overlays\/(scenes|variables|assets|triggers|token)\/?((?:[\w.-]{1,64})(?:\/elements(?:\/[\w.-]{1,64})?)?)?$/,
            );
            if (!m)
                return Response.json(
                    { ok: false, error: "Not found", code: 404 },
                    { status: 404 },
                );
            const seg =
                (m[1] as
                    | "scenes"
                    | "variables"
                    | "assets"
                    | "triggers"
                    | "token"
                    | undefined) ?? null;
            // seg=null → the project itself
            const rest = (m[2] as string | undefined) ?? "";
            // rest shapes: "", ":sceneId", ":sceneId/elements",
            // ":sceneId/elements/:elementId", "rotate"
            const [id, seg2, id2] = rest.split("/");

            if (seg === null) {
                if (req.method === "GET") {
                    const store = storeFor(user);
                    return Response.json({
                        ok: true,
                        project: store.project,
                        token: store.token,
                        updatedAt: store.updatedAt,
                    });
                }
                if (req.method === "PUT") {
                    const body = (await req.json()) as { canvas?: unknown };
                    if (body.canvas === undefined)
                        throw new ApiError("Project patch needs canvas");
                    const canvas = parseCanvasInput(body.canvas);
                    const store = storeFor(user);
                    store.project.canvas = canvas;
                    revalidate(store.project);
                    commit(user, store);
                    feed(user, "overlays.project", { project: store.project });
                    runtime(user, "overlays.canvas", { canvas });
                    return Response.json({ ok: true, project: store.project });
                }
                return notAllowed();
            }

            if (seg === "scenes") {
                if (req.method === "POST" && !rest) {
                    const body = (await req.json().catch(() => ({}))) as {
                        name?: unknown;
                    };
                    const name =
                        typeof body.name === "string" && body.name.trim()
                            ? body.name.trim().slice(0, OVERLAY_LIMITS.nameMax)
                            : "Scene";
                    const store = storeFor(user);
                    if (store.project.scenes.length >= OVERLAY_LIMITS.scenesMax)
                        throw new ApiError("Too many scenes");
                    const scene: Scene = {
                        id: randomUUID(),
                        name,
                        slug: uniqueSlug(store.project),
                        elements: [],
                    };
                    store.project.scenes.push(scene);
                    commit(user, store);
                    feed(user, "overlays.scene", { scene });
                    return Response.json({ ok: true, scene }, { status: 201 });
                }
                if (req.method === "PUT" && id && !seg2) {
                    const body = (await req.json()) as {
                        name?: unknown;
                        slug?: unknown;
                        elements?: unknown;
                    };
                    const patch = parseSceneInput(body);
                    if (body.name !== undefined && !patch.name)
                        throw new ApiError("scene name is empty");
                    const scene = mutateScene(user, id, (s) =>
                        applyScenePatch(storeFor(user).project, s, patch),
                    );
                    return Response.json({ ok: true, scene });
                }
                if (req.method === "DELETE" && id && !seg2) {
                    const store = stores.get(user);
                    if (!store) throw new ApiError("Unknown scene", 404);
                    findScene(store.project, id);
                    store.project.scenes = store.project.scenes.filter(
                        (s) => s.id !== id,
                    );
                    commit(user, store);
                    feed(user, "overlays.sceneDeleted", { sceneId: id });
                    return Response.json({ ok: true });
                }
                if (req.method === "PUT" && id && seg2 === "elements") {
                    const body = (await req.json()) as { element?: unknown };
                    if (!isRecord(body.element))
                        throw new ApiError("element is required");
                    const element = parseElementInput(body.element);
                    const scene = mutateScene(user, id, (s) => {
                        const i = s.elements.findIndex((e) => e.id === element.id);
                        if (i >= 0) s.elements[i] = element;
                        else s.elements.push(element);
                    });
                    return Response.json({ ok: true, scene });
                }
                if (req.method === "DELETE" && id && seg2 === "elements" && id2) {
                    const scene = mutateScene(user, id, (s) => {
                        const i = s.elements.findIndex((e) => e.id === id2);
                        if (i < 0) throw new ApiError("Unknown element", 404);
                        // re-parent children of a deleted group
                        s.elements = s.elements
                            .filter((e) => e.id !== id2)
                            .map((e) => (e.parentId === id2 ? { ...e, parentId: null } : e));
                    });
                    return Response.json({ ok: true, scene });
                }
                return notAllowed();
            }

            if (seg === "variables") {
                if (req.method === "POST" && !rest) {
                    const body = (await req.json()) as {
                        name?: unknown;
                        type?: unknown;
                        value?: unknown;
                    };
                    const store = storeFor(user);
                    if (store.project.variables.length >= OVERLAY_LIMITS.variablesMax)
                        throw new ApiError("Too many variables");
                    const name = typeof body.name === "string" ? body.name.trim() : "";
                    if (
                        !NAME_RE.test(name) ||
                        store.project.variables.some((v) => v.name === name)
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
                    const variable: Variable = { id: randomUUID(), name, type, value };
                    store.project.variables.push(variable);
                    revalidate(store.project);
                    commit(user, store);
                    feed(user, "overlays.variables", {
                        variables: store.project.variables,
                    });
                    runtime(user, "overlays.variables", {
                        variables: store.project.variables,
                    });
                    return Response.json({ ok: true, variable }, { status: 201 });
                }
                if (req.method === "PUT" && id && !seg2) {
                    const body = (await req.json()) as {
                        name?: unknown;
                        type?: unknown;
                        value?: unknown;
                    };
                    const store = stores.get(user);
                    if (!store) throw new ApiError("Unknown variable", 404);
                    const variable = store.project.variables.find((v) => v.id === id);
                    if (!variable) throw new ApiError("Unknown variable", 404);
                    if (body.name !== undefined) {
                        const name = typeof body.name === "string" ? body.name.trim() : "";
                        if (
                            !NAME_RE.test(name) ||
                            store.project.variables.some(
                                (v) => v.name === name && v.id !== id,
                            )
                        )
                            throw new ApiError("Invalid or duplicate name");
                        variable.name = name;
                    }
                    if (body.type !== undefined && body.type !== variable.type) {
                        if (!VALID_TYPES.includes(body.type as Variable["type"]))
                            throw new ApiError("Invalid type");
                        variable.type = body.type as Variable["type"];
                    }
                    if (body.value !== undefined)
                        variable.value = parseVariableValueInput(body.value, variable);
                    revalidate(store.project);
                    commit(user, store);
                    feed(user, "overlays.variables", {
                        variables: store.project.variables,
                    });
                    runtime(user, "overlays.variables", {
                        variables: store.project.variables,
                    });
                    return Response.json({ ok: true, variable });
                }
                if (req.method === "DELETE" && id && !seg2) {
                    const store = stores.get(user);
                    if (!store) throw new ApiError("Unknown variable", 404);
                    const before = store.project.variables.length;
                    store.project.variables = store.project.variables.filter(
                        (v) => v.id !== id,
                    );
                    if (store.project.variables.length === before)
                        throw new ApiError("Unknown variable", 404);
                    // drop bindings to the removed variable
                    for (const s of store.project.scenes)
                        for (const e of s.elements)
                            for (const [k, b] of Object.entries(e.bindings))
                                if (b.variableId === id) delete e.bindings[k];
                    revalidate(store.project);
                    commit(user, store);
                    feed(user, "overlays.variables", {
                        variables: store.project.variables,
                    });
                    runtime(user, "overlays.variables", {
                        variables: store.project.variables,
                    });
                    return Response.json({ ok: true });
                }
                return notAllowed();
            }

            if (seg === "assets") {
                if (req.method === "POST" && !rest) {
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
                        typeof body.mime === "string" && body.mime.startsWith("image/")
                            ? body.mime
                            : null;
                    const dataBase64 =
                        typeof body.dataBase64 === "string" ? body.dataBase64 : null;
                    if (!mime || !dataBase64)
                        throw new ApiError(
                            "Asset needs filename, image mime and base64 data",
                        );
                    if (dataBase64.length > OVERLAY_LIMITS.assetBase64Max)
                        throw new ApiError("Asset is too large");
                    const store = storeFor(user);
                    if (store.project.assets.length >= OVERLAY_LIMITS.assetsMax)
                        throw new ApiError("Too many assets");
                    const hash = createHash("sha256")
                        .update(Buffer.from(dataBase64, "base64"))
                        .digest("hex");
                    let asset = store.project.assets.find((a) => a.hash === hash);
                    if (!asset) {
                        asset = { id: randomUUID(), hash, mime, filename, dataBase64 };
                        store.project.assets.push(asset);
                    }
                    commit(user, store);
                    feed(user, "overlays.project", { project: store.project });
                    runtime(user, "overlays.assets", {
                        assets: store.project.assets,
                    });
                    return Response.json({ ok: true, asset }, { status: 201 });
                }
                if (req.method === "DELETE" && id && !seg2) {
                    const store = stores.get(user);
                    if (!store) throw new ApiError("Unknown asset", 404);
                    const before = store.project.assets.length;
                    store.project.assets = store.project.assets.filter(
                        (a) => a.id !== id,
                    );
                    if (store.project.assets.length === before)
                        throw new ApiError("Unknown asset", 404);
                    // image elements referencing it fall back to an empty box
                    for (const s of store.project.scenes)
                        for (const e of s.elements)
                            if (e.type === "image" && e.props.assetId === id)
                                e.props.assetId = "";
                    revalidate(store.project);
                    commit(user, store);
                    feed(user, "overlays.project", { project: store.project });
                    runtime(user, "overlays.assets", {
                        assets: store.project.assets,
                    });
                    return Response.json({ ok: true });
                }
                return notAllowed();
            }

            if (seg === "triggers") {
                if (req.method === "POST" && !rest) {
                    const body = (await req.json()) as {
                        sceneId?: unknown;
                        eventName?: unknown;
                        payload?: unknown;
                    };
                    const sceneId = typeof body.sceneId === "string" ? body.sceneId : "";
                    const store = stores.get(user);
                    if (!store) throw new ApiError("Unknown scene", 404);
                    const scene = findScene(store.project, sceneId);
                    const eventName =
                        typeof body.eventName === "string"
                            ? body.eventName.trim().slice(0, 100)
                            : "";
                    if (!eventName) throw new ApiError("eventName is required");
                    const payload = isRecord(body.payload) ? body.payload : undefined;
                    const data = { sceneId: scene.id, eventName, payload };
                    feed(user, "overlays.trigger", data);
                    runtime(user, "overlays.trigger", data);
                    return Response.json({ ok: true });
                }
                return notAllowed();
            }

            if (seg === "token") {
                if (req.method === "POST" && rest === "rotate") {
                    const store = storeFor(user);
                    store.token = generateOverlayToken();
                    commit(user, store);
                    feed(user, "overlays.token", { token: store.token });
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
                    error: err instanceof Error ? err.message : "Internal error",
                    code,
                },
                { status: code },
            );
        }
    }

    // ── runtime access (token-authenticated, no user session) ────────────

    function runtimeStore(token: string): [string, Store] | null {
        for (const [user, s] of stores)
            if (overlayTokenMatches(s.token, token)) return [user, s];
        return null;
    }

    return {
        api,
        projectFor: (user: string) => storeFor(user).project,
        runtimeScene: (token: string, slug: string): RuntimeScene | null => {
            const hit = runtimeStore(token);
            if (!hit) return null;
            const [user, store] = hit;
            const scene = store.project.scenes.find((s) => s.slug === slug);
            if (!scene) return null;
            return {
                user,
                scene,
                variables: store.project.variables,
                canvas: store.project.canvas,
                assets: store.project.assets,
            };
        },
    };
}
