/*
 * OBS overlay editor: shared project schema, validation and migrations.
 *
 * The control server persists one `Project` per user as a JSON blob
 * (see server/backend/overlays/overlay_store.ts). The runtime page renders a scene from the
 * same types (server/frontend/ts/overlays/overlay_render.tsx). Validation is hand-rolled
 * `ApiError` style like the rest of the server (no Zod in this repo).
 *
 * Round-trip rule: unknown fields on every object are preserved so newer
 * server/clients can read projects written by older ones.
 */
import type {
    OverlayElementSchema,
    PropReaders,
} from "./contracts/overlay_element";
import { overlayElementSchema } from "./overlay_elements";
import { ApiError } from "./params";

export const OVERLAY_SCHEMA_VERSION = 1;

const TOKEN_BYTES = 32;
const TOKEN_CHARS = "abcdef0123456789";

export type VariableType = "string" | "number" | "boolean" | "color";

export interface Variable {
    id: string;
    name: string;
    type: VariableType;
    /** color values are "#rrggbb"; number/boolean/string as the type says. */
    value: string | number | boolean;
}

export interface Asset {
    id: string;
    /** hex content hash (sha-256) — dedupe key */
    hash: string;
    mime: string;
    filename: string;
    /** base64-encoded bytes; kept in the project blob (control-server precedent:
     * dashboards store whole widgets as JSON blobs, no per-file store). */
    dataBase64: string;
}

export interface Transform {
    x: number;
    y: number;
    width: number;
    height: number;
    /** degrees, positive = clockwise */
    rotation: number;
    /** 0..1 */
    opacity: number;
}

/** v1: variable references only (handoff Q5). `expr` kind arrives with a
 * schema bump + sandbox; the type keeps the discriminator for that. */
export type Binding = { kind: "variable"; variableId: string };

/** An element type id. The set of valid types is whatever the modules
 * contribute (`shared/overlay_elements.ts`); the core never names one. */
export type OverlayElementType = string;

export type ElementBase = {
    id: string;
    name: string;
    type: OverlayElementType;
    transform: Transform;
    visible: boolean;
    locked: boolean;
    /** parent element id (group); root elements are null */
    parentId: string | null;
    /**
     * Attribute path → variable binding. Keys may target:
     *
     * - `props.<name>` — the raw element prop (text, url, fill, …); the
     *   variable value replaces the prop value,
     * - `transform.<field>` — x, y, width, height, rotation, opacity; the
     *   variable value is coerced to a finite number (opacity must be 0–1),
     * - `visible` — the element is shown when the variable value is truthy.
     *
     * `resolveElement` (frontend) evaluates all of them at render time.
     */
    bindings: Record<string, Binding>;
    props: Record<string, unknown>;
};

export type OverlayElement = ElementBase & Record<string, unknown>;

export interface Scene {
    id: string;
    name: string;
    /** URL-safe, unique per project, used in the runtime URL */
    slug: string;
    /** back-to-front order: index 0 renders first */
    elements: OverlayElement[];
    /** Server-managed monotonic counter (bumped on every scene mutation).
     * Editors ignore stale WS pushes that carry a lower rev than the
     * freshest state they already applied, so out-of-order broadcasts can't
     * clobber recent edits. Absent from scenes created before this field;
     * normalization preserves it via spreadRest. */
    rev?: number;
}

export interface OverlayProject {
    schemaVersion: number;
    canvas: Canvas;
    variables: Variable[];
    assets: Asset[];
    scenes: Scene[];
}

/** Scene canvas size in logical px (OBS renders at 1:1 when unscaled). */
export interface Canvas {
    width: number;
    height: number;
}

/** A variable's current value, typed by its `Variable.type`. */
export type VariableValue = string | number | boolean;

// ── limits ──────────────────────────────────────────────────────────────
export const OVERLAY_LIMITS = {
    canvasMax: 8192,
    canvasMin: 16,
    nameMax: 120,
    scenesMax: 50,
    elementsMax: 500,
    variablesMax: 200,
    assetsMax: 100,
    /** base64 length (chars) of a single asset */
    assetBase64Max: 1024 * 1024 * 25,
    /** base64 length of the whole asset set */
    projectBase64Max: 1024 * 1024 * 100,
    coordMax: 100000,
} as const;

// ── helpers ─────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/** Constant-time token comparison for runtime URLs. */
export function overlayTokenMatches(
    expected: string,
    provided: string,
): boolean {
    if (!expected || !provided || expected.length !== provided.length)
        return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++)
        diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
    return diff === 0;
}

/** 64 hex chars, `crypto.getRandomValues` (works on plain-HTTP control servers). */
export function generateOverlayToken(): string {
    const bytes = new Uint8Array(TOKEN_BYTES);
    crypto.getRandomValues(bytes);
    let out = "";
    for (const b of bytes) out += TOKEN_CHARS[b % TOKEN_CHARS.length];
    return out;
}

export function defaultCanvas(): { width: number; height: number } {
    return { width: 1920, height: 1080 };
}

/** A fresh per-user project: empty scene, ready to compose. */
export function defaultProject(): OverlayProject {
    return {
        schemaVersion: OVERLAY_SCHEMA_VERSION,
        canvas: defaultCanvas(),
        variables: [],
        assets: [],
        scenes: [
            {
                id: crypto.randomUUID(),
                name: "Scene 1",
                slug: "scene-1",
                elements: [],
            },
        ],
    };
}

const normalizeCanvas = (raw: unknown): { width: number; height: number } => {
    const r = isRecord(raw) ? raw : {};
    const w = Number(r.width);
    const h = Number(r.height);
    if (!Number.isInteger(w) || !Number.isInteger(h))
        throw new Error("canvas must have integer width/height");
    if (
        w < OVERLAY_LIMITS.canvasMin ||
        w > OVERLAY_LIMITS.canvasMax ||
        h < OVERLAY_LIMITS.canvasMin ||
        h > OVERLAY_LIMITS.canvasMax
    )
        throw new Error("canvas must be within 16..8192 on both axes");
    return { width: w, height: h };
};

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const normalizeVariable = (raw: unknown): Variable => {
    if (!isRecord(raw)) throw new Error("variable must be an object");
    const id = typeof raw.id === "string" && raw.id ? raw.id : "";
    const name =
        typeof raw.name === "string" &&
        NAME_RE.test(raw.name) &&
        raw.name.length <= OVERLAY_LIMITS.nameMax
            ? raw.name
            : "";
    const type = raw.type;
    if (
        !id ||
        !name ||
        (type !== "string" &&
            type !== "number" &&
            type !== "boolean" &&
            type !== "color")
    )
        throw new Error("variable needs id, [a-zA-Z_] name and a valid type");
    let value: string | number | boolean;
    switch (type) {
        case "number":
            value = Number(raw.value);
            if (!Number.isFinite(value))
                throw new Error("number value is not finite");
            break;
        case "boolean":
            value = !!raw.value;
            break;
        case "color":
            value =
                typeof raw.value === "string" && /^#[0-9a-f]{6}$/i.test(raw.value)
                    ? raw.value.toLowerCase()
                    : "#000000";
            break;
        default:
            value = raw.value == null ? "" : String(raw.value);
    }
    return {
        id,
        name,
        type,
        value,
        ...spreadRest(raw, ["id", "name", "type", "value"]),
    };
};

const normalizeAsset = (raw: unknown): Asset => {
    if (!isRecord(raw)) throw new Error("asset must be an object");
    const id = typeof raw.id === "string" && raw.id ? raw.id : "";
    const hash = typeof raw.hash === "string" && raw.hash ? raw.hash : "";
    const mime =
        typeof raw.mime === "string" && raw.mime.startsWith("image/")
            ? raw.mime
            : "";
    const filename =
        typeof raw.filename === "string" && raw.filename
            ? raw.filename.slice(0, 255)
            : "";
    const dataBase64 =
        typeof raw.dataBase64 === "string" &&
        raw.dataBase64.length <= OVERLAY_LIMITS.assetBase64Max
            ? raw.dataBase64
            : "";
    if (!id || !hash || !mime || !filename || !dataBase64)
        throw new Error("asset needs id, hash, image mime, filename and data");
    return { id, hash, mime, filename, dataBase64 };
};

const normalizeTransform = (raw: unknown): Transform => {
    const r = isRecord(raw) ? raw : {};
    const num = (k: "x" | "y"): number => {
        const v = Number(r[k]);
        if (!Number.isFinite(v) || Math.abs(v) > OVERLAY_LIMITS.coordMax)
            throw new Error(`transform.${k} out of range`);
        return v;
    };
    const size = (k: "width" | "height"): number => {
        const v = Number(r[k]);
        if (!Number.isFinite(v) || v < 0 || v > OVERLAY_LIMITS.coordMax)
            throw new Error(`transform.${k} out of range`);
        return v;
    };
    const rotation = Number(r.rotation ?? 0);
    const opacity = Number(r.opacity ?? 1);
    if (!Number.isFinite(rotation) || rotation < -720 || rotation > 720)
        throw new Error("transform.rotation out of range");
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
        throw new Error("transform.opacity out of range");
    return {
        x: num("x"),
        y: num("y"),
        width: size("width"),
        height: size("height"),
        rotation,
        opacity,
    };
};

const COLOR_HEX = /^#[0-9a-f]{6}$/i;

/**
 * Coerce an element's props through its schema. Unknown keys are always
 * preserved (forward compatibility); the schema returns safe values for the
 * keys it knows.
 */
const normalizeProps = (
    schema: OverlayElementSchema,
    raw: unknown,
): Record<string, unknown> => {
    const props: Record<string, unknown> = { ...(isRecord(raw) ? raw : {}) };
    const read: PropReaders = {
        num: (k, fallback, min, max) => {
            const v = Number(props[k]);
            return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
        },
        hex: (k, fallback) =>
            typeof props[k] === "string" && COLOR_HEX.test(props[k])
                ? (props[k] as string).toLowerCase()
                : fallback,
        str: (k, fallback, max) =>
            typeof props[k] === "string"
                ? max === undefined
                    ? (props[k] as string)
                    : (props[k] as string).slice(0, max)
                : fallback,
        oneOf: (k, allowed, fallback) =>
            allowed.includes(props[k] as never) ? (props[k] as never) : fallback,
        bool: (k) => props[k] === true,
    };
    return { ...props, ...schema.normalizeProps(props, read) };
};

const normalizeBinding = (raw: unknown): Binding => {
    if (
        isRecord(raw) &&
        raw.kind === "variable" &&
        typeof raw.variableId === "string" &&
        raw.variableId
    )
        return { kind: "variable", variableId: raw.variableId };
    throw new Error("binding must be a variable reference in v1");
};

const normalizeElement = (raw: unknown): OverlayElement => {
    if (!isRecord(raw)) throw new Error("element must be an object");
    const id = typeof raw.id === "string" && raw.id ? raw.id : "";
    const name =
        typeof raw.name === "string" && raw.name
            ? raw.name.slice(0, OVERLAY_LIMITS.nameMax)
            : "";
    const type = typeof raw.type === "string" ? raw.type : "";
    const schema = overlayElementSchema(type);
    if (!id || !name || !schema)
        throw new Error("element needs id, name and a valid type");
    const transform = normalizeTransform(raw.transform);
    const visible = raw.visible !== false;
    const locked = raw.locked === true;
    const parentId =
        typeof raw.parentId === "string" && raw.parentId ? raw.parentId : null;
    const bindingsRaw = isRecord(raw.bindings) ? raw.bindings : {};
    const bindings: Record<string, Binding> = {};
    for (const [k, v] of Object.entries(bindingsRaw))
        bindings[k] = normalizeBinding(v);
    const props = normalizeProps(schema, raw.props);
    return {
        id,
        name,
        type,
        transform,
        visible,
        locked,
        parentId,
        bindings,
        props,
        ...spreadRest(raw, [
            "id",
            "name",
            "type",
            "transform",
            "visible",
            "locked",
            "parentId",
            "bindings",
            "props",
        ]),
    };
};

export function slugify(name: string): string {
    const s = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return s || "scene";
}

const normalizeScene = (raw: unknown): Scene => {
    if (!isRecord(raw)) throw new Error("scene must be an object");
    const id = typeof raw.id === "string" && raw.id ? raw.id : "";
    const name =
        typeof raw.name === "string" && raw.name
            ? raw.name.slice(0, OVERLAY_LIMITS.nameMax)
            : "";
    const slug =
        typeof raw.slug === "string" && /^[a-z0-9][a-z0-9-]{0,60}$/.test(raw.slug)
            ? raw.slug
            : "";
    const elementsRaw = Array.isArray(raw.elements) ? raw.elements : [];
    if (elementsRaw.length > OVERLAY_LIMITS.elementsMax)
        throw new Error("scene has too many elements");
    const elements = elementsRaw.map(normalizeElement);
    // structural checks: parent exists and is a group; no parent cycles
    const byId = new Map(elements.map((e) => [e.id, e] as const));
    const ids = new Set<string>();
    for (const e of elements) {
        if (ids.has(e.id)) throw new Error("duplicate element id");
        ids.add(e.id);
    }
    // -1 marks an in-progress node so parent cycles are caught
    const depth = new Map<string, number>();
    const walk = (id: string): number => {
        const seen = depth.get(id);
        if (seen !== undefined) return seen;
        depth.set(id, -1);
        const el = byId.get(id);
        let d = 0;
        if (el?.parentId) {
            const parent = byId.get(el.parentId);
            if (!parent) throw new Error(`element ${el.name} has missing parent`);
            if (!overlayElementSchema(parent.type)?.container)
                throw new Error(`element ${el.name} has a non-group parent`);
            const pd = walk(parent.id);
            if (pd === -1) throw new Error("cyclic element parents");
            d = 1 + pd;
        }
        depth.set(id, d);
        return d;
    };
    for (const e of elements) walk(e.id);
    if (!id || !name || !slug) throw new Error("scene needs id, name and slug");
    return {
        id,
        name,
        slug,
        elements,
        ...spreadRest(raw, ["id", "name", "slug", "elements"]),
    };
};

/** Preserve unknown fields (everything not consumed by a known shape). */
function spreadRest(
    raw: Record<string, unknown>,
    known: string[],
): Record<string, unknown> {
    const rest: Record<string, unknown> = {};
    for (const k of Object.keys(raw)) {
        if (!known.includes(k) && !(k in rest)) rest[k] = raw[k];
    }
    return Object.keys(rest).length ? rest : {};
}

// ── migrations ──────────────────────────────────────────────────────────

type Migration = (p: OverlayProject) => OverlayProject;

/** Ordered chain: MIGRATIONS[v] migrates a project FROM version v to v+1.
 * Add the next step here when the schema bumps. */
const MIGRATIONS: Record<number, Migration> = {
    // v1 is the first schema; nothing to migrate into it.
};

/**
 * Load a persisted project: run pending migrations, then normalize.
 * Throws `Error` with a user-visible message when the project is corrupt or
 * from an unknown (newer) schema — callers surface that, never render half
 * a scene.
 */
export function migrateProjectBlob(raw: unknown): {
    project: OverlayProject;
    migrated: boolean;
} {
    let p: Record<string, unknown>;
    if (!isRecord(raw)) throw new Error("overlay project is not a JSON object");
    p = { ...raw };
    const version = Number(p.schemaVersion);
    if (!Number.isInteger(version) || version < 1)
        throw new Error("overlay project has no schemaVersion");
    if (version > OVERLAY_SCHEMA_VERSION)
        throw new Error(
            `overlay project is schemaVersion ${version}; this control server is too old to load it`,
        );
    let migrated = false;
    for (let v = version; v < OVERLAY_SCHEMA_VERSION; v++) {
        const step = MIGRATIONS[v];
        if (!step) throw new Error(`missing migration v${v}→v${v + 1}`);
        p = step(p as unknown as OverlayProject) as unknown as Record<
            string,
            unknown
        >;
        migrated = true;
    }
    p.schemaVersion = OVERLAY_SCHEMA_VERSION;
    const project = normalizeProject(p);
    return { project, migrated };
}

export function normalizeProject(raw: Record<string, unknown>): OverlayProject {
    const canvas = normalizeCanvas(raw.canvas);
    const variablesRaw = Array.isArray(raw.variables) ? raw.variables : [];
    const assetsRaw = Array.isArray(raw.assets) ? raw.assets : [];
    const scenesRaw = Array.isArray(raw.scenes) ? raw.scenes : [];
    if (variablesRaw.length > OVERLAY_LIMITS.variablesMax)
        throw new Error("project has too many variables");
    if (assetsRaw.length > OVERLAY_LIMITS.assetsMax)
        throw new Error("project has too many assets");
    if (scenesRaw.length > OVERLAY_LIMITS.scenesMax)
        throw new Error("project has too many scenes");
    const variables = variablesRaw.map(normalizeVariable);
    const assets = assetsRaw.map(normalizeAsset);
    const varIds = new Set(variables.map((v) => v.id));
    const assetIds = new Set(assets.map((a) => a.id));
    const projectBase64 = assets.reduce((n, a) => n + a.dataBase64.length, 0);
    if (projectBase64 > OVERLAY_LIMITS.projectBase64Max)
        throw new Error("overlay project assets are too large");
    const scenes = scenesRaw.map(normalizeScene);
    const slugIds = new Set<string>();
    for (const s of scenes) {
        if (slugIds.has(s.slug)) throw new Error(`duplicate scene slug ${s.slug}`);
        slugIds.add(s.slug);
        // bindings must reference existing variables; image assets must exist
        for (const e of s.elements) {
            for (const b of Object.values(e.bindings))
                if (!varIds.has(b.variableId))
                    throw new Error(
                        `scene ${s.name}: binding to unknown variable ${b.variableId}`,
                    );
            for (const key of overlayElementSchema(e.type)?.assetProps ?? []) {
                const aid = e.props[key];
                if (typeof aid === "string" && aid && !assetIds.has(aid))
                    throw new Error(
                        `scene ${s.name}: element ${e.name} references a missing asset`,
                    );
            }
        }
    }
    return {
        schemaVersion: OVERLAY_SCHEMA_VERSION,
        canvas,
        variables,
        assets,
        scenes,
        ...spreadRest(raw, [
            "schemaVersion",
            "canvas",
            "variables",
            "assets",
            "scenes",
        ]),
    };
}

// ── strict REST input validators (ApiError style) ───────────────────────

export function parseCanvasInput(raw: unknown): {
    width: number;
    height: number;
} {
    try {
        return normalizeCanvas(raw);
    } catch (e) {
        throw new ApiError(e instanceof Error ? e.message : "invalid canvas");
    }
}

export function parseSceneInput(raw: unknown): {
    name?: string;
    slug?: string;
    elements?: OverlayElement[];
} {
    if (!isRecord(raw)) throw new ApiError("body must be an object");
    const name =
        typeof raw.name === "string" && raw.name.trim()
            ? raw.name.trim().slice(0, OVERLAY_LIMITS.nameMax)
            : undefined;
    const slug =
        typeof raw.slug === "string" && /^[a-z0-9][a-z0-9-]{0,60}$/.test(raw.slug)
            ? raw.slug
            : undefined;
    let elements: OverlayElement[] | undefined;
    if (raw.elements !== undefined) {
        if (!Array.isArray(raw.elements))
            throw new ApiError("elements must be an array");
        try {
            elements = raw.elements.map(normalizeElement);
        } catch (e) {
            throw new ApiError(e instanceof Error ? e.message : "invalid elements");
        }
    }
    if (name === undefined && slug === undefined && elements === undefined)
        throw new ApiError("scene patch needs name, slug or elements");
    return { name, slug, elements };
}

export function parseElementInput(raw: unknown): OverlayElement {
    try {
        return normalizeElement(raw);
    } catch (e) {
        throw new ApiError(e instanceof Error ? e.message : "invalid element");
    }
}

export function parseVariableValueInput(
    raw: unknown,
    variable: Variable,
): string | number | boolean {
    switch (variable.type) {
        case "number": {
            const v = Number(raw);
            if (!Number.isFinite(v))
                throw new ApiError(`${variable.name} must be a finite number`);
            return v;
        }
        case "boolean":
            return typeof raw === "boolean" ? raw : !!raw;
        case "color": {
            if (typeof raw !== "string" || !/^#[0-9a-f]{6}$/i.test(raw))
                throw new ApiError(`${variable.name} must be #rrggbb`);
            return raw.toLowerCase();
        }
        default:
            return raw == null ? "" : String(raw);
    }
}
