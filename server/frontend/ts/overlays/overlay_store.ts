import { apiTry } from "@ui/api_client";
import { elementDef } from "@ui/overlay/registry";
import { uuid } from "@ui/util";
import m from "mithril";
import type {
    Asset,
    Overlay,
    OverlayElement,
    Transform,
    Variable,
    VariableValue,
} from "../../../../shared/overlay";
import { serverLive } from "../services/serverws";
import type { ElementContext } from "./overlay_render";
import { assetUrl, resolveElement } from "./overlay_render";

/** A user's overlay as the list page renders it (no element payload). */
export interface OverlaySummary {
    id: string;
    name: string;
    token: string;
    elementCount: number;
    updatedAt: number;
}

export interface HistEntry {
    overlayId: string;
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

export const state = {
    loaded: false,
    /** the user's overlays (list page). */
    overlays: [] as OverlaySummary[],
    /** the overlay the editor page has loaded (full state), or null. */
    overlay: null as Overlay | null,
    /** the loaded overlay's token (editor); the list carries per-row tokens. */
    token: "",
    selectedOverlayId: null as string | null,
    selectedElementId: null as string | null,
    zoom: 0.5,
    newOverlayName: "",
    renamingOverlayId: null as string | null,
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
    /** Overlay whose runtime URL was just copied from the list (green icon). */
    copiedOverlayId: null as string | null,
    /** Element currently expanded in the inspector list (accordion). */
    expandedElementId: null as string | null,
    /** Text element being inline-edited on the canvas. */
    editingElementId: null as string | null,
    /** Runtime URL dialog (opened from the toolbar icon) is open. */
    runtimeDialogOpen: false,
    /** Variables modal (opened from the toolbar icon) is open. */
    variablesDialogOpen: false,
};

/** Page URLs: the list and one editor page per overlay (linkable). */
export const LIST_URL = "/overlays/";
export const editorUrl = (overlayId: string): string =>
    `/overlays/edit/${encodeURIComponent(overlayId)}/`;
/** The overlay id an editor page URL names, or null on any other URL. */
export const overlayIdFromLocation = (): string | null => {
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
    const c = state.overlay?.canvas;
    const scroll = document.querySelector<HTMLElement>(".ov-canvas-scroll");
    if (!scroll || !c?.width || !c?.height) return;

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

/** The overlay the editor page has loaded (the single source of truth). */
export function overlay(): Overlay | undefined {
    return state.overlay ?? undefined;
}

export function selElement(): OverlayElement | undefined {
    return state.overlay?.elements.find(
        (e) => e.id === state.selectedElementId,
    );
}

export function ctx(): ElementContext {
    const o = state.overlay;
    if (!o)
        return {
            assetUrls: new Map(),
            variables: new Map(),
            variableNames: new Map(),
            token: state.token,
            overlayId: undefined,
        };
    return {
        assetUrls: new Map(o.assets.map((a) => [a.id, assetUrl(a)])),
        variables: new Map(
            o.variables.map((v) => [v.id, v.value as VariableValue]),
        ),
        variableNames: new Map(
            o.variables.map((v) => [v.name, v.value as VariableValue]),
        ),
        token: state.token,
        overlayId: state.selectedOverlayId ?? undefined,
    };
}

/** Resolved display transform (bindings applied) — for drag start, snapping,
 * and the selection box, so bound elements behave like their shown geometry. */
export function resolvedTransform(e: OverlayElement): Transform {
    return resolveElement(e, ctx().variables).transform;
}

/** The runtime URL for an overlay (its own token, its own id). Accepts a list
 * row (`OverlaySummary`) or the editor's `{ id, token }` pair. */
export function runtimeUrl(s: { id: string; token: string }): string {
    return (
        location.origin +
        "/overlay/" +
        encodeURIComponent(s.id) +
        "?token=" +
        s.token
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

/** Copy an overlay's runtime URL so it can be pasted straight into OBS.
 * The list row's copy icon turns green until the state expires. */
export async function copyOverlayUrl(s: {
    id: string;
    token: string;
}): Promise<void> {
    try {
        await navigator.clipboard.writeText(runtimeUrl(s));
        state.copiedOverlayId = s.id;
        setTimeout(() => {
            state.copiedOverlayId = null;
            m.redraw();
        }, 1500);
    } catch {
        /* clipboard unavailable — the URL text is visible on the row */
    }
}

/** How many field bindings in the loaded overlay follow the given variable.
 * Zero variables read as "unused", so the panel can flag them. */
export function variableUsage(variableId: string): number {
    const o = state.overlay;
    if (!o) return 0;
    let n = 0;
    for (const e of o.elements)
        for (const b of Object.values(e.bindings))
            if (b.kind === "variable" && b.variableId === variableId) n++;
    return n;
}

/** Fetch the overlay list; an editor page also loads the overlay its URL
 * names. */
export async function load(overlayId: string | null = null): Promise<void> {
    const list = await apiTry<{ overlays: OverlaySummary[] }>("/api/overlays");
    if (list?.overlays) state.overlays = list.overlays;
    if (overlayId) {
        const body = await apiTry<{ token: string; overlay: Overlay }>(
            `/api/overlays/${encodeURIComponent(overlayId)}`,
        );
        if (body?.overlay) {
            state.overlay = body.overlay;
            state.token = body.token ?? "";
            state.selectedOverlayId = overlayId;
        }
    }
    state.past = [];
    state.future = [];
    state.loaded = true;
    m.redraw();
}

export function snapshot(): void {
    const o = state.overlay;
    if (!o || !state.selectedOverlayId) return;
    state.past.push({
        overlayId: state.selectedOverlayId,
        elements: clone(o.elements),
    });
    if (state.past.length > 100) state.past.shift();
    state.future = [];
}

export function applyElements(elements: OverlayElement[]): void {
    const o = state.overlay;
    if (!o) return;
    o.elements = elements;
    void saveOverlayElements(o);
    m.redraw();
}

export function undo(): void {
    const o = state.overlay;
    if (!o || !state.past.length) return;
    state.future.push({
        overlayId: state.selectedOverlayId ?? "",
        elements: clone(o.elements),
    });
    const entry = state.past.pop()!;
    if (entry.overlayId === state.selectedOverlayId)
        applyElements(entry.elements);
}

export function redo(): void {
    const o = state.overlay;
    if (!o || !state.future.length) return;
    state.past.push({
        overlayId: state.selectedOverlayId ?? "",
        elements: clone(o.elements),
    });
    const entry = state.future.pop()!;
    if (entry.overlayId === state.selectedOverlayId)
        applyElements(entry.elements);
}

/** Create a fresh overlay and open it in the editor. */
export async function createOverlay(): Promise<void> {
    const name = state.newOverlayName.trim() || "Overlay";
    const body = await apiTry<{ id: string }>(`/api/overlays`, {
        method: "POST",
        body: { name },
    });
    if (body?.id) {
        state.newOverlayName = "";
        location.assign(editorUrl(body.id));
    }
}

/** An overlay id from a full/summary frame, kept in sync with the list. */
export function upsertListEntry(id: string, patch: Partial<OverlaySummary>): void {
    const i = state.overlays.findIndex((x) => x.id === id);
    if (i >= 0) state.overlays[i] = { ...state.overlays[i], ...patch };
}

export async function renameOverlay(id: string, name: string): Promise<void> {
    const s = state.overlays.find((x) => x.id === id);
    if (!s || !name.trim()) return;
    s.name = name.trim();
    const body = await apiTry<{ overlay: Overlay }>(
        `/api/overlays/${encodeURIComponent(id)}`,
        { method: "PUT", body: { name: s.name } },
    );
    if (body?.overlay) {
        upsertListEntry(id, { name: body.overlay.name, elementCount: body.overlay.elements.length });
        if (state.selectedOverlayId === id && state.overlay)
            state.overlay.name = body.overlay.name;
        m.redraw();
    }
}

export async function deleteOverlay(id: string): Promise<void> {
    const body = await apiTry<{ ok: boolean }>(
        `/api/overlays/${encodeURIComponent(id)}`,
        { method: "DELETE" },
    );
    if (body) {
        state.overlays = state.overlays.filter((s) => s.id !== id);
        if (state.selectedOverlayId === id) {
            state.selectedOverlayId = null;
            state.overlay = null;
        }
        m.redraw();
    }
}

export async function duplicateOverlay(id: string): Promise<void> {
    await apiTry<{ id: string }>(
        `/api/overlays/${encodeURIComponent(id)}/duplicate`,
        { method: "POST" },
    );
}

export async function saveOverlayElements(o: Overlay): Promise<void> {
    if (!state.selectedOverlayId) return;
    await apiTry(`/api/overlays/${encodeURIComponent(state.selectedOverlayId)}`, {
        method: "PUT",
        body: { elements: o.elements },
    });
}

export function mutateElement(fn: (e: OverlayElement) => void): void {
    mutateElementOf(state.selectedElementId, fn);
}

/**
 * Apply `fn` to one element by id (not to the canvas selection) and persist
 * the overlay. The inspector rows use this so expanded-row edits always hit
 * the row's element, even when it is not the canvas-selected one.
 */
export function mutateElementOf(
    elementId: string | null,
    fn: (e: OverlayElement) => void,
): void {
    const o = state.overlay;
    if (!o) return;
    const e = o.elements.find((x) => x.id === elementId);
    if (!e || e.locked) return;
    snapshot();
    fn(e);
    void saveOverlayElements(o);
    m.redraw();
}

/** Set the lock state of an element. Deliberately NOT routed through
 * `mutateElementOf` — its `e.locked` guard is what protects locked elements
 * from edits, and it would also block the very action that unlocks them. */
export function setElementLocked(elementId: string, locked: boolean): void {
    const o = state.overlay;
    if (!o) return;
    const e = o.elements.find((x) => x.id === elementId);
    if (!e || e.locked === locked) return;
    snapshot();
    e.locked = locked;
    void saveOverlayElements(o);
    m.redraw();
}

/** Types the user can create from the canvas toolbar. Each type's default
 * props and size come from its `OverlayElementDef` — the core never
 * hardcodes element-specific defaults. */
export function addElement(type: string): void {
    const o = state.overlay;
    if (!o) return;
    const def = elementDef(type);
    if (!def) return;
    snapshot();
    const el: OverlayElement = {
        id: uuid(),
        name: type + " " + (o.elements.length + 1),
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
    o.elements.push(el);
    state.selectedElementId = el.id;
    state.expandedElementId = el.id;
    void saveOverlayElements(o);
    m.redraw();
}

export function deleteElement(id: string): void {
    const o = state.overlay;
    if (!o) return;
    snapshot();
    o.elements = o.elements
        .filter((e) => e.id !== id)
        .map((e) => (e.parentId === id ? { ...e, parentId: null } : e));
    if (state.selectedElementId === id) state.selectedElementId = null;
    if (state.expandedElementId === id) state.expandedElementId = null;
    void saveOverlayElements(o);
    m.redraw();
}

/**
 * Reorder an element within `overlay.elements` (back-to-front array order =
 * z-order). Works on locked elements too — stacking is not a positional edit.
 */
export function reorderElement(
    elementId: string,
    op: "forward" | "backward",
): void {
    const o = state.overlay;
    if (!o) return;
    const i = o.elements.findIndex((x) => x.id === elementId);
    if (i < 0) return;
    if (op === "forward" && i === o.elements.length - 1) return;
    if (op === "backward" && i === 0) return;
    snapshot();
    const list = [...o.elements];
    const [el] = list.splice(i, 1);
    const to = op === "forward" ? i + 1 : i - 1;
    list.splice(to, 0, el);
    o.elements = list;
    void saveOverlayElements(o);
    m.redraw();
}

export async function createVariable(): Promise<void> {
    const o = state.overlay;
    if (!o) return;
    const name = state.newVariableName.trim();
    if (!name) return;
    const body = await apiTry<{ variable: Variable }>(
        `/api/overlays/${encodeURIComponent(state.selectedOverlayId ?? "")}/variables`,
        {
            method: "POST",
            body: { name, type: state.newVariableType },
        },
    );
    if (body?.variable) {
        state.newVariableName = "";
        m.redraw();
    }
}

export async function setVariable(
    id: string,
    value: VariableValue,
): Promise<void> {
    const o = state.overlay;
    if (!o) return;
    const v = o.variables.find((x) => x.id === id);
    if (!v) return;
    v.value = value;
    await apiTry(
        `/api/overlays/${encodeURIComponent(state.selectedOverlayId ?? "")}/variables/${encodeURIComponent(id)}`,
        {
            method: "PUT",
            body: { value },
        },
    );
    m.redraw();
}

export async function deleteVariable(id: string): Promise<void> {
    const o = state.overlay;
    if (!o) return;
    const body = await apiTry<{ ok: boolean }>(
        `/api/overlays/${encodeURIComponent(state.selectedOverlayId ?? "")}/variables/${encodeURIComponent(id)}`,
        { method: "DELETE" },
    );
    if (body) {
        o.variables = o.variables.filter((v) => v.id !== id);
        m.redraw();
    }
}

/** Upload a file and return the (deduplicated by hash) asset. */
export async function uploadAsset(file: File): Promise<Asset | null> {
    const o = state.overlay;
    if (!o) return null;
    const dataBase64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
            const s = String(r.result);
            resolve(s.slice(s.indexOf(",") + 1));
        };
        r.onerror = reject;
        r.readAsDataURL(file);
    });
    const res = await apiTry<{ asset?: Asset }>(
        `/api/overlays/${encodeURIComponent(state.selectedOverlayId ?? "")}/assets`,
        {
            method: "POST",
            body: {
                filename: file.name,
                mime: file.type,
                dataBase64,
            },
        },
    );
    return res?.asset ?? null;
}

export async function rotateToken(): Promise<void> {
    if (!state.selectedOverlayId) return;
    const body = await apiTry<{ token: string }>(
        `/api/overlays/${encodeURIComponent(state.selectedOverlayId)}/token/rotate`,
        { method: "POST" },
    );
    if (body?.token) {
        state.token = body.token;
        m.redraw();
    }
}

export async function copyRuntimeUrl(s: {
    id: string;
    token: string;
}): Promise<void> {
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
    const e = state.overlay?.elements.find((x) => x.id === elementId);
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

/** A pushed overlay is stale when it carries a lower server rev than the copy
 * we already have locally — an out-of-order broadcast must not clobber a
 * newer applied state. Overlays without revs (pre-rev data) are never stale. */
export function overlayIsStale(
    local: Overlay | undefined,
    pushed: Overlay,
): boolean {
    if (!local || typeof local.rev !== "number") return false;
    return typeof pushed.rev === "number" && pushed.rev < local.rev;
}

/** Keep the list row in sync (name + element count) after an overlay change. */
function syncListFromOverlay(id: string, o: Overlay): void {
    const i = state.overlays.findIndex((x) => x.id === id);
    if (i >= 0)
        state.overlays[i] = {
            ...state.overlays[i],
            name: o.name,
            elementCount: o.elements.length,
        };
}

serverLive.rpc.on("overlays.overlays", (data) => {
    const list = (data as { overlays?: OverlaySummary[] })?.overlays;
    if (list) {
        state.overlays = list;
        m.redraw();
    }
});

serverLive.rpc.on("overlays.overlay", (data) => {
    const { overlayId, overlay: o } = (data as {
        overlayId?: string;
        overlay?: Overlay;
    }) ?? {};
    if (!overlayId || !o) return;
    syncListFromOverlay(overlayId, o);
    if (overlayId === state.selectedOverlayId && state.overlay) {
        if (overlayIsStale(state.overlay, o)) return;
        // live frames are slim (no asset bytes) — keep the local list, which
        // the `overlays.assets` frames (and initial load) keep in sync
        o.assets = state.overlay.assets;
        state.overlay = o;
    }
    m.redraw();
});

serverLive.rpc.on("overlays.assets", (data) => {
    const assets = (data as { assets?: Asset[] })?.assets;
    if (!assets || !state.overlay) return;
    state.overlay.assets = assets;
    m.redraw();
});

serverLive.rpc.on("overlays.token", (data) => {
    const { overlayId, token } = (data as {
        overlayId?: string;
        token?: string;
    }) ?? {};
    if (!overlayId || !token) return;
    const i = state.overlays.findIndex((x) => x.id === overlayId);
    if (i >= 0) state.overlays[i] = { ...state.overlays[i], token };
    if (overlayId === state.selectedOverlayId) state.token = token;
    m.redraw();
});
