import { apiTry } from "@ui/api_client";
import { elementDef } from "@ui/overlay/registry";
import { uuid } from "@ui/util";
import m from "mithril";
import type {
    Asset,
    OverlayElement,
    OverlayProject,
    Scene,
    Transform,
    Variable,
    VariableValue,
} from "../../../../shared/overlay";
import { serverLive } from "../services/serverws";
import type { ElementContext } from "./overlay_render";
import { assetUrl, resolveElement } from "./overlay_render";

export interface HistEntry {
    sceneId: string;
    elements: OverlayElement[];
}

export interface Drag {
    elementId: string;
    mode: "move" | "resize" | "line";
    handle: string; // n, s, e, w, ne, nw, se, sw — or a, b for line endpoints
    startX: number;
    startY: number;
    start: Transform;
    moved: boolean;
}

export function initialProject(): OverlayProject {
    return {
        schemaVersion: 1,
        canvas: { width: 1920, height: 1080 },
        variables: [],
        assets: [],
        scenes: [
            // the scene's UUID id is its only identifier (runtime + editor)
            { id: uuid(), name: "Scene 1", elements: [] },
        ],
    };
}

export const state = {
    loaded: false,
    project: initialProject(),
    token: "",
    selectedSceneId: null as string | null,
    selectedElementId: null as string | null,
    zoom: 0.5,
    newSceneName: "",
    renamingSceneId: null as string | null,
    renameValue: "",
    drag: null as Drag | null,
    snapX: null as number | null,
    snapY: null as number | null,
    past: [] as HistEntry[],
    future: [] as HistEntry[],
    newVariableName: "",
    newVariableType: "string",
    copied: false,
    /** Variable whose modify URL was just copied (icon turns green). */
    copiedVariableName: null as string | null,
    /** Scene whose runtime URL was just copied from the list (icon turns green). */
    copiedSceneId: null as string | null,
    /** Element currently expanded in the inspector list (accordion). */
    expandedElementId: null as string | null,
    /** Text element being inline-edited on the canvas. */
    editingElementId: null as string | null,
    /** Runtime URL dialog (opened from the toolbar icon) is open. */
    runtimeDialogOpen: false,
    /** Variables modal (opened from the toolbar icon) is open. */
    variablesDialogOpen: false,
};

/** Page URLs: the list and one editor page per scene (linkable). */
export const LIST_URL = "/overlays/";
export const editorUrl = (sceneId: string): string =>
    `/overlays/edit/${encodeURIComponent(sceneId)}/`;
/** The scene id an editor page URL names, or null on any other URL. */
export const sceneIdFromLocation = (): string | null => {
    const m = /\/overlays\/edit\/([^/]+)\/?$/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
};

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const clamp = (v: number, a: number, b: number) =>
    Math.min(b, Math.max(a, v));

export const roundToStep = (v: number, step: number) =>
    Math.round(v / step) * step;

/** Fit the whole canvas into the editor viewport (clamped to the zoom limits). */
export function fitZoom(): void {
    const c = state.project.canvas;
    const scroll = document.querySelector<HTMLElement>(".ov-canvas-scroll");
    if (!scroll || !c.width || !c.height) return;

    const pad = 0;
    state.zoom = clamp(
        Math.min(
            (scroll.clientWidth - pad) / c.width,
            (scroll.clientHeight - pad) / c.height,
        ),
        0.1,
        3,
    );
    m.redraw();
}

export function scene(): Scene | undefined {
    return state.project.scenes.find((s) => s.id === state.selectedSceneId);
}

export function selElement(): OverlayElement | undefined {
    const s = scene();
    return s?.elements.find((e) => e.id === state.selectedElementId);
}

export function ctx(): ElementContext {
    const project = state.project;
    return {
        assetUrls: new Map(project.assets.map((a) => [a.id, assetUrl(a)])),
        variables: new Map(
            project.variables.map((v) => [v.id, v.value as VariableValue]),
        ),
        variableNames: new Map(
            project.variables.map((v) => [v.name, v.value as VariableValue]),
        ),
        token: state.token,
        sceneId: scene()?.id,
    };
}

/** Resolved display transform (bindings applied) — for drag start, snapping,
 * and the selection box, so bound elements behave like their shown geometry. */
export function resolvedTransform(e: OverlayElement): Transform {
    return resolveElement(e, ctx().variables).transform;
}

export function runtimeUrl(s: Scene): string {
    return (
        location.origin +
        "/overlay/" +
        encodeURIComponent(s.id) +
        "?token=" +
        state.token
    );
}

/** Token-authenticated URL that revalues one variable: complete the
 * trailing `…&<name>=` with a value, leave it empty to clear the variable. */
export function variableUrl(name: string): string {
    return (
        location.origin +
        "/overlay/variables?token=" +
        state.token +
        "&" +
        encodeURIComponent(name) +
        "="
    );
}

/** Copy the scene's runtime URL so it can be pasted straight into OBS.
 * The row's copy icon turns green until the state expires. */
export async function copySceneUrl(s: Scene): Promise<void> {
    try {
        await navigator.clipboard.writeText(runtimeUrl(s));
        state.copiedSceneId = s.id;
        setTimeout(() => {
            state.copiedSceneId = null;
            m.redraw();
        }, 1500);
    } catch {
        /* clipboard unavailable — the URL text is visible on the row */
    }
}

/** How many field bindings in the current scene follow the given variable.
 * Zero variables read as "unused", so the panel can flag them. */
export function variableUsage(variableId: string): number {
    const s = scene();
    if (!s) return 0;
    let n = 0;
    for (const e of s.elements)
        for (const b of Object.values(e.bindings))
            if (b.kind === "variable" && b.variableId === variableId) n++;
    return n;
}

/** Fetch the project; an editor page passes the scene id its URL names. */
export async function load(sceneId: string | null = null): Promise<void> {
    const body = await apiTry<{ project: OverlayProject; token: string }>(
        "/api/overlays",
    );
    if (body?.project) {
        state.project = body.project;
        state.token = body.token ?? "";
        if (sceneId) state.selectedSceneId = sceneId;
        if (!state.selectedSceneId || !scene())
            state.selectedSceneId = state.project.scenes[0]?.id ?? null;
        state.past = [];
        state.future = [];
    }
    state.loaded = true;
    m.redraw();
}

export function snapshot(): void {
    const s = scene();
    if (!s) return;
    state.past.push({ sceneId: s.id, elements: clone(s.elements) });
    if (state.past.length > 100) state.past.shift();
    state.future = [];
}

export function applyElements(elements: OverlayElement[]): void {
    const s = scene();
    if (!s) return;
    s.elements = elements;
    void saveSceneElements(s);
    m.redraw();
}

export function undo(): void {
    const s = scene();
    if (!s || !state.past.length) return;
    state.future.push({ sceneId: s.id, elements: clone(s.elements) });
    const entry = state.past.pop()!;
    if (entry.sceneId === s.id) applyElements(entry.elements);
}

export function redo(): void {
    const s = scene();
    if (!s || !state.future.length) return;
    state.past.push({ sceneId: s.id, elements: clone(s.elements) });
    const entry = state.future.pop()!;
    if (entry.sceneId === s.id) applyElements(entry.elements);
}

export async function createScene(): Promise<void> {
    const name = state.newSceneName.trim() || "Scene";
    const body = await apiTry<{ scene: Scene }>("/api/overlays/scenes", {
        method: "POST",
        body: { name },
    });
    if (body?.scene) {
        // upsert — the server's `overlays.scene` WS push may already have added
        // this scene (it fires before the HTTP response), so a raw push would
        // create a duplicate
        upsertScene(body.scene);
        state.newSceneName = "";
        location.assign(editorUrl(body.scene.id));
    }
}

/** Idempotently insert or replace a scene by id (mirrors the WS handler). */
export function upsertScene(sc: Scene): void {
    const i = state.project.scenes.findIndex((x) => x.id === sc.id);
    if (i >= 0) state.project.scenes[i] = sc;
    else state.project.scenes.push(sc);
}

/** Duplicate a scene (server clones it under a fresh id and name) and
 * open the clone in the editor, like createScene. */
export async function duplicateScene(id: string): Promise<void> {
    const body = await apiTry<{ scene: Scene }>(
        `/api/overlays/scenes/${encodeURIComponent(id)}/duplicate`,
        { method: "POST" },
    );
    if (body?.scene) {
        // upsert — same double-add race as createScene: the `overlays.scene`
        // WS push lands before the HTTP response and already contains the
        // clone, so a raw push would create a duplicate
        upsertScene(body.scene);
        //location.assign(editorUrl(body.scene.id));
    }
}

export function selectScene(id: string): void {
    state.selectedSceneId = id;
    state.selectedElementId = null;
    state.past = [];
    state.future = [];
}

export async function renameScene(id: string, name: string): Promise<void> {
    const s = state.project.scenes.find((x) => x.id === id);
    if (!s || !name.trim()) return;
    s.name = name.trim();
    const body = await apiTry<{ scene: Scene }>(
        `/api/overlays/scenes/${encodeURIComponent(id)}`,
        { method: "PUT", body: { name: s.name } },
    );
    if (body?.scene) {
        const i = state.project.scenes.findIndex((x) => x.id === id);
        if (i >= 0) state.project.scenes[i] = body.scene;
        m.redraw();
    }
}

export async function deleteScene(id: string): Promise<void> {
    const body = await apiTry<{ ok: boolean }>(
        `/api/overlays/scenes/${encodeURIComponent(id)}`,
        { method: "DELETE" },
    );
    if (body) {
        state.project.scenes = state.project.scenes.filter((s) => s.id !== id);
        if (state.selectedSceneId === id)
            selectScene(state.project.scenes[0]?.id ?? "");
        m.redraw();
    }
}

export async function saveSceneElements(s: Scene): Promise<void> {
    await apiTry(`/api/overlays/scenes/${encodeURIComponent(s.id)}`, {
        method: "PUT",
        body: { elements: s.elements },
    });
}

export function mutateElement(fn: (e: OverlayElement) => void): void {
    mutateElementOf(state.selectedElementId, fn);
}

/**
 * Apply `fn` to one element by id (not to the canvas selection) and persist
 * the scene. The inspector rows use this so expanded-row edits always hit
 * the row's element, even when it is not the canvas-selected one.
 */
export function mutateElementOf(
    elementId: string | null,
    fn: (e: OverlayElement) => void,
): void {
    const s = scene();
    if (!s) return;
    const e = s.elements.find((x) => x.id === elementId);
    if (!e || e.locked) return;
    snapshot();
    fn(e);
    void saveSceneElements(s);
    m.redraw();
}

/** Set the lock state of an element. Deliberately NOT routed through
 * `mutateElementOf` — its `e.locked` guard is what protects locked elements
 * from edits, and it would also block the very action that unlocks them. */
export function setElementLocked(elementId: string, locked: boolean): void {
    const s = scene();
    if (!s) return;
    const e = s.elements.find((x) => x.id === elementId);
    if (!e || e.locked === locked) return;
    snapshot();
    e.locked = locked;
    void saveSceneElements(s);
    m.redraw();
}

/** Types the user can create from the canvas toolbar. Each type's default
 * props and size come from its `OverlayElementDef` — the core never
 * hardcodes element-specific defaults. */
export function addElement(type: string): void {
    const s = scene();
    if (!s) return;
    const def = elementDef(type);
    if (!def) return;
    snapshot();
    const el: OverlayElement = {
        id: uuid(),
        name: type + " " + (s.elements.length + 1),
        type,
        transform: {
            x: 120,
            y: 120,
            width: def.defaultSize.width,
            height: def.defaultSize.height,
            rotation: 0,
            opacity: 1,
        },
        visible: true,
        locked: false,
        parentId: null,
        bindings: {},
        props: { ...def.defaultProps },
    };
    s.elements.push(el);
    state.selectedElementId = el.id;
    state.expandedElementId = el.id;
    void saveSceneElements(s);
    m.redraw();
}

export function deleteElement(id: string): void {
    const s = scene();
    if (!s) return;
    snapshot();
    s.elements = s.elements
        .filter((e) => e.id !== id)
        .map((e) => (e.parentId === id ? { ...e, parentId: null } : e));
    if (state.selectedElementId === id) state.selectedElementId = null;
    if (state.expandedElementId === id) state.expandedElementId = null;
    void saveSceneElements(s);
    m.redraw();
}

/**
 * Reorder an element within `scene.elements` (back-to-front array order =
 * z-order). Works on locked elements too — stacking is not a positional edit.
 */
export function reorderElement(
    elementId: string,
    op: "forward" | "backward",
): void {
    const s = scene();
    if (!s) return;
    const i = s.elements.findIndex((x) => x.id === elementId);
    if (i < 0) return;
    if (op === "forward" && i === s.elements.length - 1) return;
    if (op === "backward" && i === 0) return;
    snapshot();
    const list = [...s.elements];
    const [el] = list.splice(i, 1);
    const to = op === "forward" ? i + 1 : i - 1;
    list.splice(to, 0, el);
    s.elements = list;
    void saveSceneElements(s);
    m.redraw();
}

export async function createVariable(): Promise<void> {
    const name = state.newVariableName.trim();
    if (!name) return;
    const body = await apiTry<{ variable: Variable }>(
        "/api/overlays/variables",
        {
            method: "POST",
            body: { name, type: state.newVariableType },
        },
    );
    if (body?.variable) {
        // upsert — same double-add race as createScene: the `overlays.variables`
        // WS push lands before the HTTP response and already contains the new
        // variable, so a raw push would duplicate it
        upsertVariable(body.variable);
        state.newVariableName = "";
        m.redraw();
    }
}

/** Idempotently insert or replace a variable by id (mirrors the WS handler). */
export function upsertVariable(v: Variable): void {
    const i = state.project.variables.findIndex((x) => x.id === v.id);
    if (i >= 0) state.project.variables[i] = v;
    else state.project.variables.push(v);
}

export async function setVariable(
    id: string,
    value: VariableValue,
): Promise<void> {
    const v = state.project.variables.find((x) => x.id === id);
    if (!v) return;
    v.value = value;
    await apiTry(`/api/overlays/variables/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { value },
    });
    m.redraw();
}

export async function deleteVariable(id: string): Promise<void> {
    const body = await apiTry<{ ok: boolean }>(
        `/api/overlays/variables/${encodeURIComponent(id)}`,
        { method: "DELETE" },
    );
    if (body) {
        state.project.variables = state.project.variables.filter(
            (v) => v.id !== id,
        );
        m.redraw();
    }
}

/** Upload a file and return the (deduplicated by hash) asset. */
export async function uploadAsset(file: File): Promise<Asset | null> {
    const dataBase64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
            const s = String(r.result);
            resolve(s.slice(s.indexOf(",") + 1));
        };
        r.onerror = reject;
        r.readAsDataURL(file);
    });
    const res = await apiTry<{ asset?: Asset }>("/api/overlays/assets", {
        method: "POST",
        body: {
            filename: file.name,
            mime: file.type,
            dataBase64,
        },
    });
    return res?.asset ?? null;
}

export async function rotateToken(): Promise<void> {
    const body = await apiTry<{ token: string }>("/api/overlays/token/rotate", {
        method: "POST",
    });
    if (body?.token) {
        state.token = body.token;
        m.redraw();
    }
}

export async function copyRuntimeUrl(s: Scene): Promise<void> {
    try {
        await navigator.clipboard.writeText(runtimeUrl(s));
        state.copied = true;
        setTimeout(() => {
            state.copied = false;
            m.redraw();
        }, 1500);
    } catch {
        /* clipboard unavailable — the URL text is visible on the page */
    }
}

export async function copyVariableUrl(name: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(variableUrl(name));
        state.copiedVariableName = name;
        setTimeout(() => {
            state.copiedVariableName = null;
            m.redraw();
        }, 1500);
    } catch {
        /* clipboard unavailable — the URL stays usable via curl/copy-paste */
    }
}

export function selectElement(elementId: string | null): void {
    state.selectedElementId = elementId;
    state.expandedElementId = elementId;
    state.editingElementId = null;
    m.redraw();
}

/** Row-head click: select the element and toggle that row's expanded state. */
export function toggleElementRow(elementId: string): void {
    state.selectedElementId = elementId;
    state.editingElementId = null;
    state.expandedElementId =
        state.expandedElementId === elementId ? null : elementId;
    m.redraw();
}

/** Enter inline text editing on the canvas (double-click a text element). */
export function startInlineEdit(elementId: string): void {
    const e = scene()?.elements.find((x) => x.id === elementId);
    const inline = e && elementDef(e.type)?.inlineEdit;
    if (!e || !inline || e.locked) return;
    // a bound prop wins over the raw value — inline editing the raw value
    // would be a no-op on screen, so don't offer it
    if (e.bindings[`props.${inline.prop}`]) return;
    snapshot();
    state.editingElementId = elementId;
    state.selectedElementId = elementId;
    m.redraw();
}

export function stopInlineEdit(): void {
    if (state.editingElementId === null) return;
    state.editingElementId = null;
    m.redraw();
}

/** A pushed scene is stale when it carries a lower server rev than the copy
 * we already have locally — an out-of-order broadcast must not clobber a
 * newer applied state. Scenes without revs (pre-rev data) are never stale. */
export function sceneIsStale(local: Scene | undefined, pushed: Scene): boolean {
    if (!local || typeof local.rev !== "number") return false;
    return typeof pushed.rev === "number" && pushed.rev < local.rev;
}

serverLive.rpc.on("overlays.scene", (data) => {
    const sc = (data as { scene?: Scene })?.scene;
    if (!sc) return;
    const i = state.project.scenes.findIndex((x) => x.id === sc.id);
    if (i >= 0) {
        if (sceneIsStale(state.project.scenes[i], sc)) return;
        state.project.scenes[i] = sc;
    } else state.project.scenes.push(sc);
    m.redraw();
});

serverLive.rpc.on("overlays.sceneDeleted", (data) => {
    const id = (data as { sceneId?: string })?.sceneId;
    if (!id) return;
    state.project.scenes = state.project.scenes.filter((s) => s.id !== id);
    if (state.selectedSceneId === id)
        selectScene(state.project.scenes[0]?.id ?? "");
    m.redraw();
});

serverLive.rpc.on("overlays.variables", (data) => {
    const list = (data as { variables?: Variable[] })?.variables;
    if (list) {
        state.project.variables = list;
        m.redraw();
    }
});

serverLive.rpc.on("overlays.project", (data) => {
    const p = (data as { project?: OverlayProject })?.project;
    if (p) {
        // An out-of-order project push must not roll back scenes whose local
        // copy is already fresher (higher server rev) than the push.
        const localRev = new Map(
            state.project.scenes.map((s) => [s.id, s.rev] as const),
        );
        p.scenes = p.scenes.map((sc) => {
            const lr = localRev.get(sc.id);
            return typeof lr === "number" &&
                typeof sc.rev === "number" &&
                sc.rev < lr
                ? state.project.scenes.find((x) => x.id === sc.id) ?? sc
                : sc;
        });
        state.project = p;
        m.redraw();
    }
});

serverLive.rpc.on("overlays.token", (data) => {
    const tk = (data as { token?: string })?.token;
    if (tk) state.token = tk;
});
