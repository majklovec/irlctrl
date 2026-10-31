/** @jsx m */
/*
 * OBS Overlay editor page (/overlays/).
 *
 * Two views in one SPA (like the Dashboards list → editor flow):
 *   list:    dashboard-style list of overlays (create / delete / open)
 *   editor:
 *     left rail:  scene list (create / rename / delete / select)
 *     center:     zoomable canvas — select / drag / resize / nudge / snap
 *     right rail: inspector for the selected element (transform, props, binding)
 *     footers:    variables (live), triggers (fire), runtime URL (copy/rotate), assets
 *
 * The scene renders through the SHARED overlay-render views so the preview is
 * pixel-identical to the OBS runtime; the editor only layers a selection box +
 * resize handles on top. The server is the source of truth: every mutation is
 * pushed to the REST API and the live feed re-syncs the local copy.
 *
 * Undo/redo (100 steps) tracks the active scene's elements. Controls are raw
 * <input>/<select> bound imperatively (the ui kit's bound controls target a
 * fixed state object, which doesn't fit a canvas editor).
 */
import m from "mithril";
import type {
	Asset,
	OverlayElement,
	OverlayProject,
	Scene,
	Transform,
	Variable,
	VariableValue,
} from "../../shared/overlay";
import { elementDef } from "./overlay-elements/registry";
import { Icon } from "./components/icons";
import { Button, Card, Page, ServerNav } from "./components/ui";
import { t } from "./i18n";
import {
	assetUrl,
	type ElementContext,
	elementStyle,
	sceneElementsView,
} from "./overlay-render";
import { serverLive } from "./services/serverws";
import { mountPage, uuid } from "./util";

// ── state ────────────────────────────────────────────────────────────────
interface HistEntry {
	sceneId: string;
	elements: OverlayElement[];
}

interface Drag {
	elementId: string;
	mode: "move" | "resize" | "line";
	handle: string; // n, s, e, w, ne, nw, se, sw — or a, b for line endpoints
	startX: number;
	startY: number;
	start: Transform;
	moved: boolean;
}

function initialProject(): OverlayProject {
	return {
		schemaVersion: 1,
		canvas: { width: 1920, height: 1080 },
		variables: [],
		assets: [],
		scenes: [{ id: uuid(), name: "Scene 1", slug: "scene-1", elements: [] }],
	};
}

const state = {
	loaded: false,
	/** "list" shows the overlay list page; "editor" opens the scene editor. */
	view: "list" as "list" | "editor",
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
	triggerName: "",
	copied: false,
	/** Element currently expanded in the inspector list (accordion). */
	expandedElementId: null as string | null,
	/** Text element being inline-edited on the canvas. */
	editingElementId: null as string | null,
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function scene(): Scene | undefined {
	return state.project.scenes.find((s) => s.id === state.selectedSceneId);
}
function selElement(): OverlayElement | undefined {
	const s = scene();
	return s?.elements.find((e) => e.id === state.selectedElementId);
}
function ctx(): ElementContext {
	return {
		assetUrls: new Map(state.project.assets.map((a) => [a.id, assetUrl(a)])),
		variables: new Map(
			state.project.variables.map((v) => [v.id, v.value as VariableValue]),
		),
	};
}
function runtimeUrl(s: Scene): string {
	return (
		location.origin +
		"/overlay/" +
		encodeURIComponent(s.slug) +
		"?token=" +
		state.token
	);
}

// ── REST ─────────────────────────────────────────────────────────────────
async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
	const res = await fetch(path, {
		...init,
		headers: { "Content-Type": "application/json" },
		cache: "no-store",
	}).catch(() => null);
	if (!res) return null;
	const body = (await res.json().catch(() => null)) as
		| (T & { ok?: boolean; error?: string })
		| null;
	if (!res.ok || !body) {
		console.error("overlays api", path, res.status, body?.error ?? "");
		return null;
	}
	return body;
}

async function load(): Promise<void> {
	const body = await api<{ project: OverlayProject; token: string }>(
		"/api/overlays",
	);
	if (body?.project) {
		state.project = body.project;
		state.token = body.token ?? "";
		if (!state.selectedSceneId || !scene())
			state.selectedSceneId = state.project.scenes[0]?.id ?? null;
		state.past = [];
		state.future = [];
	}
	state.loaded = true;
	m.redraw();
}

// ── history ──────────────────────────────────────────────────────────────
function snapshot(): void {
	const s = scene();
	if (!s) return;
	state.past.push({ sceneId: s.id, elements: clone(s.elements) });
	if (state.past.length > 100) state.past.shift();
	state.future = [];
}
function applyElements(elements: OverlayElement[]): void {
	const s = scene();
	if (!s) return;
	s.elements = elements;
	void saveSceneElements(s);
	m.redraw();
}
function undo(): void {
	const s = scene();
	if (!s || !state.past.length) return;
	state.future.push({ sceneId: s.id, elements: clone(s.elements) });
	const entry = state.past.pop()!;
	if (entry.sceneId === s.id) applyElements(entry.elements);
}
function redo(): void {
	const s = scene();
	if (!s || !state.future.length) return;
	state.past.push({ sceneId: s.id, elements: clone(s.elements) });
	const entry = state.future.pop()!;
	if (entry.sceneId === s.id) applyElements(entry.elements);
}

// ── scene ops ────────────────────────────────────────────────────────────
async function createScene(): Promise<void> {
	const name = state.newSceneName.trim() || "Scene";
	const body = await api<{ scene: Scene }>("/api/overlays/scenes", {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	if (body?.scene) {
		// upsert — the server's `overlays.scene` WS push may already have added
		// this scene (it fires before the HTTP response), so a raw push would
		// create a duplicate
		upsertScene(body.scene);
		openEditor(body.scene.id);
		state.newSceneName = "";
	}
}
/** Switch to the scene editor for a given scene. */
function openEditor(id: string): void {
	selectScene(id);
	state.view = "editor";
	m.redraw();
}
/** Return to the overlay list without discarding the active scene. */
function backToList(): void {
	state.view = "list";
	m.redraw();
}
/** Idempotently insert or replace a scene by id (mirrors the WS handler). */
function upsertScene(sc: Scene): void {
	const i = state.project.scenes.findIndex((x) => x.id === sc.id);
	if (i >= 0) state.project.scenes[i] = sc;
	else state.project.scenes.push(sc);
}
function selectScene(id: string): void {
	state.selectedSceneId = id;
	state.selectedElementId = null;
	state.past = [];
	state.future = [];
}
async function renameScene(id: string, name: string): Promise<void> {
	const s = state.project.scenes.find((x) => x.id === id);
	if (!s || !name.trim()) return;
	s.name = name.trim();
	const body = await api<{ scene: Scene }>(
		`/api/overlays/scenes/${encodeURIComponent(id)}`,
		{ method: "PUT", body: JSON.stringify({ name: s.name }) },
	);
	if (body?.scene) {
		const i = state.project.scenes.findIndex((x) => x.id === id);
		if (i >= 0) state.project.scenes[i] = body.scene;
		m.redraw();
	}
}
async function deleteScene(id: string): Promise<void> {
	const body = await api<{ ok: boolean }>(
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

// ── element ops ──────────────────────────────────────────────────────────
async function saveSceneElements(s: Scene): Promise<void> {
	await api(`/api/overlays/scenes/${encodeURIComponent(s.id)}`, {
		method: "PUT",
		body: JSON.stringify({ elements: s.elements }),
	});
}
function mutateElement(fn: (e: OverlayElement) => void): void {
	mutateElementOf(state.selectedElementId, fn);
}
/**
 * Apply `fn` to one element by id (not to the canvas selection) and persist
 * the scene. The inspector rows use this so expanded-row edits always hit
 * the row's element, even when it is not the canvas-selected one.
 */
function mutateElementOf(
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
function setElementLocked(elementId: string, locked: boolean): void {
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
function addElement(
	type: "text" | "rectangle" | "ellipse" | "line" | "image",
): void {
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
function deleteElement(id: string): void {
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
function reorderElement(elementId: string, op: "forward" | "backward"): void {
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

// ── variable ops ─────────────────────────────────────────────────────────
async function createVariable(): Promise<void> {
	const name = state.newVariableName.trim();
	if (!name) return;
	const body = await api<{ variable: Variable }>("/api/overlays/variables", {
		method: "POST",
		body: JSON.stringify({ name, type: state.newVariableType }),
	});
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
function upsertVariable(v: Variable): void {
	const i = state.project.variables.findIndex((x) => x.id === v.id);
	if (i >= 0) state.project.variables[i] = v;
	else state.project.variables.push(v);
}
async function setVariable(id: string, value: VariableValue): Promise<void> {
	const v = state.project.variables.find((x) => x.id === id);
	if (!v) return;
	v.value = value;
	await api(`/api/overlays/variables/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify({ value }),
	});
	m.redraw();
}
async function deleteVariable(id: string): Promise<void> {
	const body = await api<{ ok: boolean }>(
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

// ── asset ops ────────────────────────────────────────────────────────────
/** Upload a file and return the (deduplicated by hash) asset. */
async function uploadAsset(file: File): Promise<Asset | null> {
	const dataBase64 = await new Promise<string>((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => {
			const s = String(r.result);
			resolve(s.slice(s.indexOf(",") + 1));
		};
		r.onerror = reject;
		r.readAsDataURL(file);
	});
	const res = await api<{ asset?: Asset }>("/api/overlays/assets", {
		method: "POST",
		body: JSON.stringify({
			filename: file.name,
			mime: file.type,
			dataBase64,
		}),
	});
	return res?.asset ?? null;
}

// ── trigger / token ──────────────────────────────────────────────────────
async function fireTrigger(): Promise<void> {
	const s = scene();
	const name = state.triggerName.trim();
	if (!s || !name) return;
	await api("/api/overlays/triggers", {
		method: "POST",
		body: JSON.stringify({ sceneId: s.id, eventName: name }),
	});
	state.triggerName = "";
	m.redraw();
}
async function rotateToken(): Promise<void> {
	const body = await api<{ token: string }>("/api/overlays/token/rotate", {
		method: "POST",
	});
	if (body?.token) {
		state.token = body.token;
		m.redraw();
	}
}
async function copyRuntimeUrl(s: Scene): Promise<void> {
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

// ── canvas drag / resize / snap ──────────────────────────────────────────
function toScenePoint(ev: MouseEvent): { x: number; y: number } {
	const el = document.querySelector(
		".overlay-canvas-scaled",
	) as HTMLElement | null;
	const rect = el?.getBoundingClientRect();
	if (!rect) return { x: 0, y: 0 };
	return {
		x: (ev.clientX - rect.left) / state.zoom,
		y: (ev.clientY - rect.top) / state.zoom,
	};
}

/** Snap an element edge/center to the canvas + other element edges (threshold
 * scales with zoom). Returns the corrected transform + the guide lines. */
function applySnap(
	e: OverlayElement,
	t: Transform,
): { gx: number | null; gy: number | null } {
	const C = state.project.canvas;
	const s = scene();
	const TH = 6 / state.zoom;
	const xTargets = [0, C.width, C.width / 2];
	const yTargets = [0, C.height, C.height / 2];
	if (s)
		for (const o of s.elements) {
			if (o.id === e.id || !o.visible) continue;
			xTargets.push(o.transform.x, o.transform.x + o.transform.width);
			yTargets.push(o.transform.y, o.transform.y + o.transform.height);
		}
	const xEdges = [t.x, t.x + t.width / 2, t.x + t.width];
	const yEdges = [t.y, t.y + t.height / 2, t.y + t.height];
	let bx = Infinity,
		by = Infinity,
		gx: number | null = null,
		gy: number | null = null;
	for (const xe of xEdges)
		for (const xt of xTargets) {
			const d = xt - xe;
			if (Math.abs(d) < TH && Math.abs(d) < Math.abs(bx)) {
				bx = d;
				gx = xt;
			}
		}
	for (const ye of yEdges)
		for (const yt of yTargets) {
			const d = yt - ye;
			if (Math.abs(d) < TH && Math.abs(d) < Math.abs(by)) {
				by = d;
				gy = yt;
			}
		}
	if (isFinite(bx)) t.x = Math.round(t.x + bx);
	if (isFinite(by)) t.y = Math.round(t.y + by);
	return { gx, gy };
}

function selectElement(elementId: string | null): void {
	state.selectedElementId = elementId;
	state.expandedElementId = elementId;
	state.editingElementId = null;
	m.redraw();
}

/** Row-head click: select the element and toggle that row's expanded state. */
function toggleElementRow(elementId: string): void {
	state.selectedElementId = elementId;
	state.editingElementId = null;
	state.expandedElementId =
		state.expandedElementId === elementId ? null : elementId;
	m.redraw();
}

/** Enter inline text editing on the canvas (double-click a text element). */
function startInlineEdit(elementId: string): void {
	const e = scene()?.elements.find((x) => x.id === elementId);
	if (!e || e.type !== "text" || e.locked) return;
	snapshot();
	state.editingElementId = elementId;
	state.selectedElementId = elementId;
	m.redraw();
}

function stopInlineEdit(): void {
	if (state.editingElementId === null) return;
	state.editingElementId = null;
	m.redraw();
}

function startDrag(
	ev: MouseEvent,
	elementId: string,
	mode: Drag["mode"],
	handle = "",
): void {
	// stop bubbling to the canvas handler first, so clicking a selection box /
	// handle never deselects (even for locked elements)
	(ev as Event).stopPropagation();
	// prevent the browser from starting its own drags (element content
	// selection, image ghosting) which would swallow mousemove mid-drag
	(ev as Event).preventDefault();
	const e = scene()?.elements.find((x) => x.id === elementId);
	if (!e || e.locked) return;
	state.selectedElementId = elementId;
	const p = toScenePoint(ev);
	state.drag = {
		elementId,
		mode,
		handle,
		startX: p.x,
		startY: p.y,
		start: { ...e.transform },
		moved: false,
	};
	snapshot();
	window.addEventListener("mousemove", onDrag);
	window.addEventListener("mouseup", endDrag);
	m.redraw();
}

function onDrag(ev: MouseEvent): void {
	const d = state.drag;
	if (!d) return;
	const e = scene()?.elements.find((x) => x.id === d.elementId);
	if (!e) return;
	const ev2 = toScenePoint(ev);
	const dx = ev2.x - d.startX;
	const dy = ev2.y - d.startY;
	if (Math.abs(dx) > 1 || Math.abs(dy) > 1) d.moved = true;
	const st = d.start;
	if (d.mode === "move") {
		e.transform = { ...st, x: st.x + dx, y: st.y + dy };
		const { gx, gy } = applySnap(e, e.transform);
		state.snapX = gx;
		state.snapY = gy;
		m.redraw();
		return;
	}
	if (d.mode === "resize") {
		const h = d.handle;
		let width = st.width,
			height = st.height;
		const MIN = 4;
		if (h.includes("e")) width = st.width + dx;
		if (h.includes("s")) height = st.height + dy;
		if (h.includes("w")) width = st.width - dx;
		if (h.includes("n")) height = st.height - dy;
		// Shift + corner handle = keep the aspect ratio: the dominant delta
		// decides the size, the other axis follows the start ratio.
		if (ev.shiftKey && h.length === 2 && st.width > 0 && st.height > 0) {
			const ratio = st.width / st.height;
			if (Math.abs(width - st.width) >= Math.abs(height - st.height))
				height = width / ratio;
			else width = height * ratio;
		}
		if (width < MIN) width = MIN;
		if (height < MIN) height = MIN;
		// The edge opposite the dragged handle stays fixed, so w/n handles
		// anchor the right/bottom edge and e/s handles the left/top edge
		// (this also keeps the anchor stable after the ratio adjusts the size).
		const x = h.includes("w") ? st.x + st.width - width : st.x;
		const y = h.includes("n") ? st.y + st.height - height : st.y;
		e.transform = {
			...st,
			x: Math.round(x),
			y: Math.round(y),
			width: Math.round(width),
			height: Math.round(height),
		};
		state.snapX = null;
		state.snapY = null;
		return;
	}
	// Line: drag one endpoint, the other stays fixed. All math happens in the
	// box's unrotated frame (the rotation is constant during the drag). The
	// server rejects negative width/height, so the box is kept in min/abs
	// form — the line is drawn centered in the box and is 180°-symmetric, so
	// that is visually identical to free endpoints.
	const th = (st.rotation * Math.PI) / 180;
	const cos = Math.cos(th),
		sin = Math.sin(th);
	const c0x = st.x + st.width / 2,
		c0y = st.y + st.height / 2;
	// fixed endpoint (the one NOT being dragged), local and world
	const fx = d.handle === "b" ? st.x : st.x + st.width;
	const fy = d.handle === "b" ? st.y : st.y + st.height;
	const fwx = c0x + (fx - c0x) * cos - (fy - c0y) * sin;
	const fwy = c0y + (fx - c0x) * sin + (fy - c0y) * cos;
	// pointer, in the box frame measured from the fixed endpoint
	const vx = ev2.x - fwx,
		vy = ev2.y - fwy;
	const ux = vx * cos + vy * sin,
		uy = -vx * sin + vy * cos;
	// new box: fixed corner + pointer corner, normalized to min/abs
	const width = Math.abs(ux);
	const height = Math.abs(uy);
	// new world center: fixed endpoint + rotated half-diagonal
	const cx = fwx + (ux * cos - uy * sin) / 2;
	const cy = fwy + (ux * sin + uy * cos) / 2;
	e.transform = {
		...st,
		x: Math.round(cx - width / 2),
		y: Math.round(cy - height / 2),
		width: Math.round(width),
		height: Math.round(height),
	};
	state.snapX = null;
	state.snapY = null;
	m.redraw();
}

function endDrag(): void {
	if (state.drag?.moved) {
		const s = scene();
		if (s) void saveSceneElements(s);
	}
	state.drag = null;
	state.snapX = null;
	state.snapY = null;
	window.removeEventListener("mousemove", onDrag);
	window.removeEventListener("mouseup", endDrag);
	m.redraw();
}

// ── keyboard ─────────────────────────────────────────────────────────────
function onKey(ev: KeyboardEvent): void {
	if (state.view !== "editor") return;
	const tag = (ev.target as HTMLElement | null)?.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	const e = selElement();
	const meta = ev.metaKey || ev.ctrlKey;
	if (meta && ev.key.toLowerCase() === "z") {
		ev.preventDefault();
		if (ev.shiftKey) redo();
		else undo();
		return;
	}
	if (meta && ev.key.toLowerCase() === "y") {
		ev.preventDefault();
		redo();
		return;
	}
	if (!e) return;
	if (ev.key === "Delete" || ev.key === "Backspace") {
		ev.preventDefault();
		deleteElement(e.id);
		return;
	}
	if (e.locked) return;
	const step = ev.shiftKey ? 10 : 1;
	const t = e.transform;
	let moved = false;
	if (ev.key === "ArrowLeft") (t.x -= step), (moved = true);
	if (ev.key === "ArrowRight") (t.x += step), (moved = true);
	if (ev.key === "ArrowUp") (t.y -= step), (moved = true);
	if (ev.key === "ArrowDown") (t.y += step), (moved = true);
	if (moved) {
		ev.preventDefault();
		snapshot();
		const s = scene();
		if (s) void saveSceneElements(s);
		m.redraw();
	}
}

// ── live feed (server / other editor tabs) ───────────────────────────────
/** A pushed scene is stale when it carries a lower server rev than the copy
 * we already have locally — an out-of-order broadcast must not clobber a
 * newer applied state. Scenes without revs (pre-rev data) are never stale. */
function sceneIsStale(local: Scene | undefined, pushed: Scene): boolean {
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
				? (state.project.scenes.find((x) => x.id === sc.id) ?? sc)
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

// ── views ────────────────────────────────────────────────────────────────
function canvasArea(): m.Vnode {
	const s = scene();
	const C = state.project.canvas;
	const el = selElement();
	return (
		<div class="ov-canvas-wrap">
			<div class="ov-canvas-scroll">
				<div
					class="overlay-canvas-scaled"
					style={{
						width: C.width + "px",
						height: C.height + "px",
						transform: "scale(" + state.zoom + ")",
						transformOrigin: "0 0",
					}}
					onmousedown={(ev: MouseEvent) => {
						// clicking an element selects + begins a drag; clicking
						// empty canvas clears the selection
						const hit = (ev.target as HTMLElement).closest<HTMLElement>(
							"[data-element]",
						);
						if (hit?.dataset.element) {
							const id = hit.dataset.element;
							const el = scene()?.elements.find((x) => x.id === id);
							if (el && !el.locked) startDrag(ev, id, "move");
							else selectElement(id);
							return;
						}
						selectElement(null);
					}}
					ondblclick={(ev: MouseEvent) => {
						const target = ev.target as HTMLElement;
						const hit = target.closest<HTMLElement>("[data-element]");
						if (hit?.dataset.element) startInlineEdit(hit.dataset.element);
						// the selection box sits on top of the selected element
						else if (target.closest(".ov-selection") && state.selectedElementId)
							startInlineEdit(state.selectedElementId);
					}}
				>
					<div
						class="overlay-canvas"
						style={{ width: C.width + "px", height: C.height + "px" }}
					>
						{s ? (
							sceneElementsView(
								// The element being inline-edited is hidden:
								// the editor's opaque textarea only covers the
								// element's box, so any text glyphs overflowing
								// it (overlay-text is overflow:visible) would
								// still show through and look like duplicated
								// text. The textarea shows the same value.
								s.elements.map((x) =>
									x.id === state.editingElementId
										? { ...x, visible: false }
										: x,
								),
								ctx(),
							)
						) : null}
						{s && state.snapX != null ? (
							<div
								class="ov-snap-line ov-snap-v"
								style={{ left: state.snapX + "px" }}
							/>
						) : null}
						{s && state.snapY != null ? (
							<div
								class="ov-snap-line ov-snap-h"
								style={{ top: state.snapY + "px" }}
							/>
						) : null}
						{el ? (
							<div
								class="ov-selection"
								style={elementStyle(el)}
								onmousedown={(ev: Event) =>
									startDrag(ev as MouseEvent, el.id, "move")
								}
							>
								{elementDef(el.type)?.handles === "endpoints" ? (
									// endpoint elements (lines) get two endpoint
									// handles (A = top-left corner, B =
									// bottom-right corner of the box) — they can
									// never present the box's 8 resize handles
									(["a", "b"] as const).map((h) => (
										<span
											key={h}
											class={"ov-line-end ov-line-" + h}
											onmousedown={(ev: Event) =>
												startDrag(
													ev as MouseEvent,
													el.id,
													"line",
													h,
												)
											}
										/>
									))
								) : elementDef(el.type)?.handles === "box" ? (
									["nw", "n", "ne", "e", "se", "s", "sw", "w"].map(
										(h) => (
											<span
												key={h}
												class={"ov-handle ov-" + h}
												onmousedown={(ev: Event) =>
													startDrag(
														ev as MouseEvent,
														el.id,
														"resize",
														h,
													)
												}
											/>
										),
									)
								) : null}
							</div>
						) : null}
						{state.editingElementId
							? inlineTextEdit(state.editingElementId, s)
							: null}
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * Inline text editor: a transparent textarea laid exactly over the text
 * element (same box, same font) so the edit is what-you-see. Enter commits
 * (Shift+Enter for a newline), Esc cancels, blur commits.
 */
function inlineTextEdit(elementId: string, s: Scene | undefined): m.Children {
	const e = s?.elements.find((x) => x.id === elementId);
	if (!e || e.type !== "text") return null;
	const p = (e.props ?? {}) as Record<string, unknown>;
	const ts = (v: unknown, d: number) =>
		typeof v === "number" && Number.isFinite(v) ? v : d;
	const align = p.textAlign;
	const ta =
		align === "center" ? "center" : align === "right" ? "right" : "left";
	const font: Record<string, string> = {
		fontFamily:
			typeof p.fontFamily === "string"
				? p.fontFamily
				: "Inter, system-ui, sans-serif",
		fontSize: `${ts(p.fontSize, 48)}px`,
		fontWeight: `${ts(p.fontWeight, 600)}`,
		lineHeight: `${ts(p.lineHeight, 1.2)}`,
		color: typeof p.color === "string" ? p.color : "#ffffff",
		textAlign: ta,
		padding: "0",
		margin: "0",
		border: "0",
		outline: "2px solid var(--accent)",
		// opaque + untransformed: the original element stays rendered
		// underneath, so a translucent or rotated textarea would double the
		// glyphs / shear them
		background: "#10131a",
		transform: "none",
		resize: "none",
		overflow: "hidden",
		width: "100%",
		height: "100%",
		display: "block",
		boxSizing: "border-box",
	};
	const commit = () => stopInlineEdit();
	return (
		<div
			class="ov-inline-edit"
			// full opacity: elementStyle() carries the element's opacity, and
			// a translucent wrapper would let the original text show through
			style={{ ...elementStyle(e), opacity: 1 }}
			onmousedown={(ev: MouseEvent) => ev.stopPropagation()}
		>
			<textarea
				class="ov-inline-edit-input"
				style={font}
				value={typeof p.text === "string" ? p.text : ""}
				ref={(dom: HTMLTextAreaElement | null) => dom?.focus()}
				oninput={(ev: Event) => {
					const sc = scene();
					const el = sc?.elements.find((x) => x.id === elementId);
					if (!sc || !el) return;
					(el.props as Record<string, unknown>).text = (
						ev.target as HTMLTextAreaElement
					).value;
					void saveSceneElements(sc);
				}}
				onkeydown={(ev: KeyboardEvent) => {
					if (ev.key === "Enter" && !ev.shiftKey) {
						ev.preventDefault();
						commit();
					} else if (ev.key === "Escape") {
						ev.preventDefault();
						undo(); // revert to the snapshot taken on edit start
						stopInlineEdit();
					}
				}}
				onblur={commit}
			/>
		</div>
	);
}

function lbl(label: string): m.Vnode {
	return <span class="ov-lbl">{label}</span>;
}

/**
 * Z-order controls (forward / backward) for one element, rendered as compact
 * arrow buttons in that element's list row.
 */
function zorderButtons(elementId: string): m.Vnode {
	const list = scene()?.elements ?? [];
	const idx = list.findIndex((x) => x.id === elementId);
	const atFront = idx === list.length - 1;
	const atBack = idx === 0;
	const ops: { op: "forward" | "backward"; dis: boolean; label: string }[] = [
		{ op: "forward", dis: atFront, label: t("overlay.bring_forward") },
		{ op: "backward", dis: atBack, label: t("overlay.send_backward") },
	];
	return (
		<span class="ov-zhead" onclick={(e: MouseEvent) => e.stopPropagation()}>
			{ops.map(({ op, dis, label }) => (
				<button
					key={op}
					type="button"
					class="ov-zbtn"
					title={label}
					aria-label={label}
					disabled={dis}
					onclick={(ev: MouseEvent) => {
						ev.stopPropagation();
						reorderElement(elementId, op);
					}}
				>
					{zArrow(op)}
				</button>
			))}
		</span>
	);
}

/** Small up/down chevron glyph for a z-order button. */
function zArrow(op: "forward" | "backward"): m.Vnode {
	const up = op === "forward";
	return (
		<svg
			viewBox="0 0 24 24"
			width="15"
			height="15"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d={up ? "m6 15 6 -6 6 6" : "m6 9 6 6 6 -6"} />
		</svg>
	);
}

/**
 * List of every element in the scene, topmost (front) first. Each element is
 * an individually collapsible row: its header carries the name plus the four
 * z-order buttons, and expanding reveals the element's property fields.
 * Clicking a row also selects the element on the canvas.
 */
function layersPanel(): m.Vnode {
	const els = scene()?.elements ?? [];
	const frontFirst = [...els].reverse();
	return (
		<div class="ov-layers">
			<ul class="ov-layers-list">
				{frontFirst.map((el) => {
					const open = state.expandedElementId === el.id;
					return (
						<li key={el.id}>
							<div
								class={
									"ov-layer ov-el" +
									(el.id === state.selectedElementId ? " ov-layer-sel" : "")
								}
								onclick={() => toggleElementRow(el.id)}
							>
								<button
									type="button"
									class="ov-el-chevbtn"
									aria-expanded={open}
									aria-label={open ? "Collapse" : "Expand"}
									onclick={(ev: MouseEvent) => {
										ev.stopPropagation();
										state.expandedElementId = open ? null : el.id;
										m.redraw();
									}}
								>
									<Icon
										name="chevron"
										class={open ? "ov-chev ov-chev-open" : "ov-chev"}
										width="14"
										height="14"
									/>
								</button>
								<span class="ov-layer-name">{el.name}</span>
								{el.locked ? <span class="ov-layer-lock">🔒</span> : null}
								{zorderButtons(el.id)}
							</div>
							{open ? <div class="ov-el-body">{elementProps(el)}</div> : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function inspector(): m.Vnode {
	return (
		<Card class="ov-rail">
			<div class="ov-inspect">{layersPanel()}</div>
		</Card>
	);
}

/** Property fields for one element, rendered inside its expanded list row. */
function elementProps(e: OverlayElement): m.Vnode {
	const tm = e.transform;
	// Mutate the row's element's real transform in place. (An earlier version
	// ran fn on a `{ ...el.transform }` copy that was discarded, so X/Y/W/H/
	// rotation/opacity edits silently did nothing.)
	const setT = (fn: (t: Transform) => void) =>
		mutateElementOf(e.id, (el) => fn(el.transform));
	// The type-specific fields are published by the element's own `editForm`
	// (OverlayElementDef) — the core renders only the common fields above and
	// delegates everything else to the registry.
	const def = elementDef(e.type);

	return (
		<>
			<label class="ov-field">
				{lbl(t("overlay.name"))}
				<input
					type="text"
					value={e.name}
					oninput={(ev: Event) =>
						mutateElementOf(e.id, (el) => {
							el.name = (ev.target as HTMLInputElement).value;
						})
					}
				/>
			</label>

			<div class="ov-grid2">
				{[
					[t("overlay.x"), tm.x, (n: number) => setT((x) => (x.x = n))],
					[t("overlay.y"), tm.y, (n: number) => setT((x) => (x.y = n))],
					[
						t("overlay.w"),
						tm.width,
						(n: number) => setT((x) => (x.width = Math.max(1, n))),
					],
					[
						t("overlay.h"),
						tm.height,
						(n: number) => setT((x) => (x.height = Math.max(1, n))),
					],
					[
						t("overlay.rotation"),
						tm.rotation,
						(n: number) => setT((x) => (x.rotation = n)),
					],
				].map(([label, value, on]) => (
					<label class="ov-field" key={String(label)}>
						{lbl(String(label))}
						<input
							type="number"
							value={Number(value)}
							oninput={(ev: Event) => {
								const n = Number((ev.target as HTMLInputElement).value);
								if (Number.isFinite(n)) (on as (n: number) => void)(n);
							}}
						/>
					</label>
				))}
				<label class="ov-field">
					{lbl(t("overlay.opacity"))}
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						value={tm.opacity}
						oninput={(ev: Event) =>
							setT((x) => {
								x.opacity = Number((ev.target as HTMLInputElement).value);
							})
						}
					/>
				</label>
			</div>

			<label class="ov-check">
				<input
					type="checkbox"
					checked={e.visible}
					onchange={(ev: Event) =>
						mutateElementOf(e.id, (el) => {
							el.visible = (ev.target as HTMLInputElement).checked;
						})
					}
				/>
				{t("overlay.visible")}
			</label>
			<label class="ov-check">
				<input
					type="checkbox"
					checked={e.locked}
					onchange={(ev: Event) =>
						setElementLocked(
							e.id,
							(ev.target as HTMLInputElement).checked,
						)
					}
				/>
				{t("overlay.locked")}
			</label>

			{def
				? def.editForm({
						element: e,
						mutate: (fn) => mutateElementOf(e.id, fn),
						assets: state.project.assets,
						variables: state.project.variables,
						upload: (f: File) =>
							uploadAsset(f).then((a) => a?.id ?? null),
					})
				: null}

			<div class="ov-danger">
				<Button
					label={t("overlay.delete")}
					class="ov-danger-btn"
					onclick={() => deleteElement(e.id)}
				/>
			</div>
		</>
	);
}

function variablesPanel(): m.Vnode {
	return (
		<Card
			title={t("overlay.variables")}
			class="ov-bottom"
			headActions={
				<span class="ov-newvar">
					<input
						type="text"
						placeholder={t("overlay.variable_name")}
						value={state.newVariableName}
						oninput={(ev: Event) =>
							(state.newVariableName = (ev.target as HTMLInputElement).value)
						}
					/>
					<select
						value={state.newVariableType}
						onchange={(ev: Event) =>
							(state.newVariableType = (ev.target as HTMLSelectElement).value)
						}
					>
						<option value="string">string</option>
						<option value="number">number</option>
						<option value="boolean">boolean</option>
						<option value="color">color</option>
					</select>
					<Button
						label={t("overlay.add")}
						onclick={() => void createVariable()}
					/>
				</span>
			}
		>
			<div class="ov-var-list">
				{state.project.variables.length === 0 ? (
					<p class="muted">{t("overlay.no_variables")}</p>
				) : (
					state.project.variables.map((v) => (
						<div key={v.id} class="ov-var">
							<span class="ov-var-name">{v.name}</span>
							{v.type === "boolean" ? (
								<input
									type="checkbox"
									checked={Boolean(v.value)}
									onchange={(ev: Event) =>
										void setVariable(
											v.id,
											(ev.target as HTMLInputElement).checked,
										)
									}
								/>
							) : v.type === "color" ? (
								<input
									type="color"
									value={String(v.value)}
									oninput={(ev: Event) =>
										void setVariable(
											v.id,
											(ev.target as HTMLInputElement).value,
										)
									}
								/>
							) : (
								<input
									type={v.type === "number" ? "number" : "text"}
									value={String(v.value)}
									oninput={(ev: Event) =>
										void setVariable(
											v.id,
											v.type === "number"
												? Number((ev.target as HTMLInputElement).value)
												: (ev.target as HTMLInputElement).value,
										)
									}
								/>
							)}
							<button
								type="button"
								class="ov-var-del"
								title={t("overlay.delete")}
								onclick={() => void deleteVariable(v.id)}
							>
								✕
							</button>
						</div>
					))
				)}
			</div>
		</Card>
	);
}

function triggersPanel(): m.Vnode {
	const s = scene();
	return (
		<Card title={t("overlay.triggers")} class="ov-bottom">
			<span class="ov-newvar">
				<input
					type="text"
					placeholder={t("overlay.event_name")}
					value={state.triggerName}
					oninput={(ev: Event) =>
						(state.triggerName = (ev.target as HTMLInputElement).value)
					}
				/>
				<Button label={t("overlay.fire")} onclick={() => void fireTrigger()} />
			</span>
			<p class="muted ov-hint">
				{s ? t("overlay.trigger_hint") : t("overlay.trigger_hint_none")}
			</p>
		</Card>
	);
}

function runtimePanel(): m.Vnode {
	const s = scene();
	return (
		<Card
			title={t("overlay.runtime_url")}
			class="ov-bottom"
			headActions={
				<>
					<Button
						label={<Icon name="sync" class="role-icon" />}
						class="icon-link"
						title={t("overlay.rotate")}
						aria-label={t("overlay.rotate")}
						onclick={() => void rotateToken()}
					/>
					{s ? (
						<Button
							label={<Icon name="copy" class="role-icon" />}
							class={state.copied ? "icon-link ov-copied" : "icon-link"}
							title={state.copied ? t("overlay.copied") : t("overlay.copy")}
							aria-label={t("overlay.copy")}
							onclick={() => void copyRuntimeUrl(s)}
						/>
					) : null}
				</>
			}
		>
			{s ? (
				<div class="ov-runtime">
					<code class="ov-url">{runtimeUrl(s)}</code>
				</div>
			) : (
				<p class="muted">{t("overlay.no_selection")}</p>
			)}
		</Card>
	);
}

function headerRight(): m.Vnode {
	return (
		<span class="ov-toolbar">
			<Button label={t("overlay.undo")} title="Ctrl+Z" onclick={undo} />
			<Button label={t("overlay.redo")} title="Ctrl+Shift+Z" onclick={redo} />
			<span class="ov-adds">
				<Button
					label={t("overlay.add_text")}
					onclick={() => addElement("text")}
				/>
				<Button
					label={t("overlay.add_rectangle")}
					onclick={() => addElement("rectangle")}
				/>
				<Button
					label={t("overlay.add_ellipse")}
					onclick={() => addElement("ellipse")}
				/>
				<Button
					label={t("overlay.add_line")}
					onclick={() => addElement("line")}
				/>
				<Button
					label={t("overlay.add_image")}
					onclick={() => addElement("image")}
				/>
			</span>
			<span class="ov-zoom">
				<Button
					label="−"
					title={t("overlay.zoom_out")}
					onclick={() => (state.zoom = clamp(state.zoom * 0.8, 0.1, 3))}
				/>
				<span class="ov-zoom-val">{Math.round(state.zoom * 100)}%</span>
				<Button
					label="+"
					title={t("overlay.zoom_in")}
					onclick={() => (state.zoom = clamp(state.zoom * 1.25, 0.1, 3))}
				/>
			</span>
		</span>
	);
}

function listToolbar(): m.Vnode {
	return (
		<div class="dash-toolbar">
			<span class="dash-empty-text">{t("overlay.new_scene")}</span>
			<input
				type="text"
				placeholder={t("overlay.scene_name")}
				value={state.newSceneName}
				oninput={(ev: Event) => {
					state.newSceneName = (ev.target as HTMLInputElement).value;
					m.redraw();
				}}
			/>
			<Button
				label={t("overlay.new_scene")}
				disabled={!state.newSceneName.trim()}
				onclick={() => void createScene()}
			/>
		</div>
	);
}

/** Dashboards-style list of overlays; click a row to open its editor. */
function overlayList(): m.Vnode {
	const scenes = state.project.scenes;
	return (
		<Card>
			{scenes.length ? (
				[
					<table class="dash-table">
						<thead>
							<tr>
								<th>{t("overlay.name")}</th>
								<th>{t("overlay.url")}</th>
								<th>{t("overlay.elements")}</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{scenes.map((s) => (
								<tr key={s.id} onclick={() => openEditor(s.id)}>
									<td class="dash-name">
										{state.renamingSceneId === s.id ? (
											<input
												class="ov-rename"
												value={state.renameValue}
												oninput={(ev: Event) =>
													(state.renameValue = (
														ev.target as HTMLInputElement
													).value)
												}
												onkeydown={(ev: KeyboardEvent) => {
													if (ev.key === "Enter")
														(ev.target as HTMLInputElement).blur();
													if (ev.key === "Escape") {
														state.renamingSceneId = null;
														m.redraw();
													}
												}}
												onblur={() => {
													void renameScene(s.id, state.renameValue);
													state.renamingSceneId = null;
													m.redraw();
												}}
												oncreate={(v) => {
													const el = v.dom as HTMLInputElement;
													el.focus();
													el.select();
												}}
											/>
										) : (
											<span class="dash-row-link">{s.name}</span>
										)}
									</td>
									<td class="muted">/overlay/{s.slug}</td>
									<td class="muted">{s.elements.length}</td>
									<td class="actions-cell">
										<div class="dash-row-actions">
											{[
												<a
													class="icon-link"
													href="#"
													title={t("overlay.open")}
													aria-label={t("overlay.open")}
													onclick={(ev: Event) => {
														ev.preventDefault();
														ev.stopPropagation();
														openEditor(s.id);
													}}
												>
													<Icon name="view" class="role-icon" />
												</a>,
												<Button
													label={<Icon name="edit" class="role-icon" />}
													class="icon-link"
													title={t("overlay.rename_scene")}
													aria-label={t("overlay.rename_scene")}
													onclick={(ev: Event) => {
														ev.stopPropagation();
														state.renamingSceneId = s.id;
														state.renameValue = s.name;
														m.redraw();
													}}
												/>,
												<Button
													label={<Icon name="delete" class="role-icon" />}
													class="icon-link dash-delete"
													title={t("overlay.delete_scene")}
													aria-label={t("overlay.delete_scene")}
													onclick={(ev: Event) => {
														ev.stopPropagation();
														if (confirm(t("overlay.confirm_delete_scene")))
															void deleteScene(s.id);
													}}
												/>,
											]}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>,
					listToolbar(),
				]
			) : (
				<div class="dash-empty">
					<p class="muted">{t("overlay.empty_list")}</p>
					{listToolbar()}
				</div>
			)}
		</Card>
	);
}

/** Editor header: back-to-list link + "Overlays / <scene>". */
function editorTitle(): m.Vnode {
	const s = scene();
	return (
		<>
			<a
				class="icon-link page-back"
				href="#"
				title={t("overlay.back_list")}
				aria-label={t("overlay.back_list")}
				onclick={(ev: Event) => {
					ev.preventDefault();
					backToList();
				}}
			>
				<span class="sr-only">{t("overlay.back_list")}</span>
				<svg
					width={16}
					height={16}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth={1.75}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M10 12L6 8l4-4" />
				</svg>
			</a>{" "}
			{t("overlay.title")}
			{s ? <> / {s.name}</> : null}
		</>
	);
}

const overlaysPage: m.Component = {
	oncreate() {
		void load();
		window.addEventListener("keydown", onKey, true);
	},
	onremove() {
		window.removeEventListener("keydown", onKey, true);
	},
	view: () => {
		if (!state.loaded)
			return (
				<Page nav={<ServerNav active="overlays" />}>
					<p class="muted">{t("overlay.loading")}</p>
				</Page>
			);
		if (state.view === "list")
			return (
				<Page title={t("overlay.title")} nav={<ServerNav active="overlays" />}>
					{overlayList()}
				</Page>
			);
		return (
			<Page
				title={editorTitle()}
				nav={<ServerNav active="overlays" />}
				headerRight={headerRight()}
			>
				<div class="ov-layout">
					<div class="ov-center">{canvasArea()}</div>
					<div class="ov-right">{inspector()}</div>
					<div class="ov-footers">
						{variablesPanel()}
						{triggersPanel()}
						{runtimePanel()}
					</div>
				</div>
			</Page>
		);
	},
};

void mountPage(() => t("overlay.title"), overlaysPage);
