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
import { DEFAULT_SHAPE_PROPS, DEFAULT_TEXT_PROPS } from "../../shared/overlay";
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
	mode: "move" | "resize";
	handle: string; // n, s, e, w, ne, nw, se, sw
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
	exportBusy: false,
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
	const e = selElement();
	if (!e || e.locked) return;
	snapshot();
	fn(e);
	const s = scene();
	if (s) void saveSceneElements(s);
	m.redraw();
}
function addElement(type: "text" | "shape" | "image" | "group"): void {
	const s = scene();
	if (!s) return;
	snapshot();
	const el: OverlayElement = {
		id: uuid(),
		name: type + " " + (s.elements.length + 1),
		type,
		transform: {
			x: 120,
			y: 120,
			width: type === "text" ? 320 : 240,
			height: type === "text" ? 80 : 160,
			rotation: 0,
			opacity: 1,
		},
		visible: true,
		locked: false,
		parentId: null,
		bindings: {},
		props:
			type === "text"
				? { ...DEFAULT_TEXTPROPS_SAFE(), text: "New text" }
				: type === "shape"
					? { ...DEFAULT_SHAPE_PROPS }
					: type === "image"
						? { assetId: "" }
						: {},
	};
	s.elements.push(el);
	state.selectedElementId = el.id;
	void saveSceneElements(s);
	m.redraw();
}
function DEFAULT_TEXTPROPS_SAFE(): Record<string, unknown> {
	return { ...DEFAULT_TEXT_PROPS };
}
function deleteElement(id: string): void {
	const s = scene();
	if (!s) return;
	snapshot();
	s.elements = s.elements
		.filter((e) => e.id !== id)
		.map((e) => (e.parentId === id ? { ...e, parentId: null } : e));
	if (state.selectedElementId === id) state.selectedElementId = null;
	void saveSceneElements(s);
	m.redraw();
}

/**
 * Reorder the selected element within `scene.elements` (back-to-front array
 * order = z-order). Works on locked elements too — stacking is not a
 * positional edit.
 */
function reorderElement(
	op: "front" | "forward" | "backward" | "back",
): void {
	const s = scene();
	const e = selElement();
	if (!s || !e) return;
	const i = s.elements.findIndex((x) => x.id === e.id);
	if (i < 0) return;
	if (op === "front" && i === s.elements.length - 1) return;
	if (op === "back" && i === 0) return;
	if (op === "forward" && i === s.elements.length - 1) return;
	if (op === "backward" && i === 0) return;
	snapshot();
	const list = [...s.elements];
	const [el] = list.splice(i, 1);
	const to =
		op === "front"
			? list.length
			: op === "back"
				? 0
				: op === "forward"
					? i + 1
					: i - 1;
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
async function uploadAsset(file: File): Promise<void> {
	const dataBase64 = await new Promise<string>((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => {
			const s = String(r.result);
			resolve(s.slice(s.indexOf(",") + 1));
		};
		r.onerror = reject;
		r.readAsDataURL(file);
	});
	await api("/api/overlays/assets", {
		method: "POST",
		body: JSON.stringify({
			filename: file.name,
			mime: file.type,
			dataBase64,
		}),
	});
}
async function deleteAsset(id: string): Promise<void> {
	await api(`/api/overlays/assets/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
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

// ── PNG export (client-side, transparent) ────────────────────────────────
async function exportPng(s: Scene): Promise<void> {
	state.exportBusy = true;
	m.redraw();
	try {
		const c = state.project.canvas;
		const svg =
			`<svg xmlns="http://www.w3.org/2000/svg" width="${c.width}" height="${c.height}">` +
			`<foreignObject x="0" y="0" width="100%" height="100%">${sceneToHtml(
				s,
				ctx(),
			)}</foreignObject></svg>`;
		const dataUrl =
			"data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const i = new Image();
			i.onload = () => resolve(i);
			i.onerror = reject;
			i.src = dataUrl;
		});
		const canvas = document.createElement("canvas");
		canvas.width = c.width;
		canvas.height = c.height;
		const g = canvas.getContext("2d");
		if (!g) return;
		g.clearRect(0, 0, c.width, c.height);
		g.drawImage(img, 0, 0);
		canvas.toBlob((blob) => {
			if (!blob) return;
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = `${s.slug}.png`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 1000);
		}, "image/png");
	} catch (err) {
		console.error("overlay export:", err);
	} finally {
		state.exportBusy = false;
		m.redraw();
	}
}

const esc = (v: string): string =>
	v
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

/** Standalone HTML for the foreignObject PNG export (mirrors overlay-render). */
function sceneToHtml(s: Scene, c: ElementContext): string {
	const parts: string[] = [];
	for (const e of s.elements) {
		if (e.type === "group") continue;
		const t = e.transform;
		const base =
			`position:absolute;left:${t.x}px;top:${t.y}px;width:${t.width}px;` +
			`height:${t.height}px;transform:rotate(${t.rotation}deg);opacity:${t.opacity};` +
			(e.visible ? "" : "visibility:hidden;");
		if (e.type === "text") {
			const p = e.props;
			parts.push(
				`<div style="${base}display:flex;overflow:visible;white-space:pre;` +
					`font-family:${esc(String(p.fontFamily ?? "Inter, sans-serif"))};` +
					`font-size:${Number(p.fontSize ?? 48)}px;color:${esc(String(p.color ?? "#fff"))};` +
					`font-weight:${Number(p.fontWeight ?? 600)};line-height:1.2;` +
					`justify-content:${
						p.textAlign === "center"
							? "center"
							: p.textAlign === "right"
								? "flex-end"
								: "flex-start"
					}">${esc(String(p.text ?? ""))}</div>`,
			);
		} else if (e.type === "shape") {
			const p = e.props;
			const shape =
				p.shape === "ellipse" || p.shape === "line" ? p.shape : "rect";
			const sw = Number(p.strokeWidth ?? 0);
			parts.push(
				`<div style="${base}background:${esc(String(p.fill ?? "#0ea5e9"))};` +
					`border-radius:${shape === "ellipse" ? "50%" : "0"}${
						sw > 0
							? `;border:${sw}px solid ${esc(String(p.stroke ?? "transparent"))}`
							: ""
					}"></div>`,
			);
		} else if (e.type === "image") {
			const aid = e.props.assetId;
			const url = typeof aid === "string" ? c.assetUrls.get(aid) : undefined;
			if (url)
				parts.push(
					`<img src="${url}" style="${base}width:100%;height:100%;object-fit:fill" />`,
				);
		}
	}
	return parts.join("");
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
	m.redraw();
}

function startDrag(
	ev: MouseEvent,
	elementId: string,
	mode: "move" | "resize",
	handle = "",
): void {
	// stop bubbling to the canvas handler first, so clicking a selection box /
	// handle never deselects (even for locked elements)
	(ev as Event).stopPropagation();
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
	const p = toScenePoint(ev);
	const dx = p.x - d.startX;
	const dy = p.y - d.startY;
	if (Math.abs(dx) > 1 || Math.abs(dy) > 1) d.moved = true;
	const st = d.start;
	if (d.mode === "move") {
		e.transform = { ...st, x: st.x + dx, y: st.y + dy };
		const { gx, gy } = applySnap(e, e.transform);
		state.snapX = gx;
		state.snapY = gy;
	} else {
		const h = d.handle;
		let x = st.x,
			y = st.y,
			width = st.width,
			height = st.height;
		const MIN = 4;
		if (h.includes("e")) width = st.width + dx;
		if (h.includes("s")) height = st.height + dy;
		if (h.includes("w")) {
			width = st.width - dx;
			x = st.x + dx;
		}
		if (h.includes("n")) {
			height = st.height - dy;
			y = st.y + dy;
		}
		if (width < MIN) {
			if (h.includes("w")) x = st.x + st.width - MIN;
			width = MIN;
		}
		if (height < MIN) {
			if (h.includes("n")) y = st.y + st.height - MIN;
			height = MIN;
		}
		e.transform = {
			...st,
			x: Math.round(x),
			y: Math.round(y),
			width: Math.round(width),
			height: Math.round(height),
		};
		state.snapX = null;
		state.snapY = null;
	}
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
serverLive.rpc.on("overlays.scene", (data) => {
	const sc = (data as { scene?: Scene })?.scene;
	if (!sc) return;
	const i = state.project.scenes.findIndex((x) => x.id === sc.id);
	if (i >= 0) state.project.scenes[i] = sc;
	else state.project.scenes.push(sc);
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
				>
					<div
						class="overlay-canvas"
						style={{ width: C.width + "px", height: C.height + "px" }}
					>
						{s ? sceneElementsView(s.elements, ctx()) : null}
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
								{["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => (
									<span
										key={h}
										class={"ov-handle ov-" + h}
										onmousedown={(ev: Event) =>
											startDrag(ev as MouseEvent, el.id, "resize", h)
										}
									/>
								))}
							</div>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}

function lbl(label: string): m.Vnode {
	return <span class="ov-lbl">{label}</span>;
}

function inspector(): m.Vnode {
	const e = selElement();
	if (!e)
		return (
			<Card title={t("overlay.inspector")} class="ov-rail">
				<p class="muted">{t("overlay.no_selection")}</p>
			</Card>
		);
	const tm = e.transform;
	const setT = (fn: (t: Transform) => void) =>
		mutateElement((el) => fn({ ...el.transform }));
	const p = e.props;

	return (
		<Card title={t("overlay.inspector")} class="ov-rail">
			<div class="ov-inspect">
				<label class="ov-field">
					{lbl(t("overlay.name"))}
					<input
						type="text"
						value={e.name}
						oninput={(ev: Event) =>
							mutateElement((el) => {
								el.name = (ev.target as HTMLInputElement).value;
							})
						}
					/>
				</label>

				<div class="ov-zorder">
					{([
						["front", t("overlay.bring_front")],
						["forward", t("overlay.bring_forward")],
						["backward", t("overlay.send_backward")],
						["back", t("overlay.send_back")],
					] as const).map(([op, label]) => (
						<button
							key={op}
							type="button"
							class="ov-zbtn"
							title={label}
							onclick={() => reorderElement(op)}
						>
							{label}
						</button>
					))}
				</div>
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
							mutateElement((el) => {
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
							mutateElement((el) => {
								el.locked = (ev.target as HTMLInputElement).checked;
							})
						}
					/>
					{t("overlay.locked")}
				</label>

				{e.type === "text" ? (
					<>
						<label class="ov-field">
							{lbl(t("overlay.text"))}
							<input
								type="text"
								value={String(p.text ?? "")}
								oninput={(ev: Event) =>
									mutateElement((el) => {
										el.props.text = (ev.target as HTMLInputElement).value;
									})
								}
							/>
						</label>
						<div class="ov-grid2">
							<label class="ov-field">
								{lbl(t("overlay.font_size"))}
								<input
									type="number"
									value={Number(p.fontSize ?? 48)}
									oninput={(ev: Event) =>
										mutateElement((el) => {
											el.props.fontSize = Number(
												(ev.target as HTMLInputElement).value,
											);
										})
									}
								/>
							</label>
							<label class="ov-field">
								{lbl(t("overlay.color"))}
								<input
									type="color"
									value={String(p.color ?? "#ffffff")}
									oninput={(ev: Event) =>
										mutateElement((el) => {
											el.props.color = (ev.target as HTMLInputElement).value;
										})
									}
								/>
							</label>
						</div>
						<div class="ov-grid2">
							<label class="ov-field">
								{lbl(t("overlay.font_weight"))}
								<select
									value={String(p.fontWeight ?? 600)}
									onchange={(ev: Event) =>
										mutateElement((el) => {
											el.props.fontWeight = Number(
												(ev.target as HTMLSelectElement).value,
											);
										})
									}
								>
									<option value="400">400</option>
									<option value="600">600</option>
									<option value="700">700</option>
									<option value="900">900</option>
								</select>
							</label>
							<label class="ov-field">
								{lbl(t("overlay.align"))}
								<select
									value={String(p.textAlign ?? "left")}
									onchange={(ev: Event) =>
										mutateElement((el) => {
											el.props.textAlign = (
												ev.target as HTMLSelectElement
											).value;
										})
									}
								>
									<option value="left">left</option>
									<option value="center">center</option>
									<option value="right">right</option>
								</select>
							</label>
						</div>
						{bindingRow(e, "text")}
					</>
				) : null}

				{e.type === "shape" ? (
					<>
						<label class="ov-field">
							{lbl(t("overlay.shape"))}
							<select
								value={String(p.shape ?? "rect")}
								onchange={(ev: Event) =>
									mutateElement((el) => {
										el.props.shape = (ev.target as HTMLSelectElement).value;
									})
								}
							>
								<option value="rect">rect</option>
								<option value="ellipse">ellipse</option>
								<option value="line">line</option>
							</select>
						</label>
						<div class="ov-grid2">
							<label class="ov-field">
								{lbl(t("overlay.fill"))}
								<input
									type="color"
									value={String(p.fill ?? "#0ea5e9")}
									oninput={(ev: Event) =>
										mutateElement((el) => {
											el.props.fill = (ev.target as HTMLInputElement).value;
										})
									}
								/>
							</label>
							<label class="ov-field">
								{lbl(t("overlay.stroke"))}
								<input
									type="color"
									value={String(p.stroke ?? "#000000")}
									oninput={(ev: Event) =>
										mutateElement((el) => {
											el.props.stroke = (ev.target as HTMLInputElement).value;
										})
									}
								/>
							</label>
						</div>
						<label class="ov-field">
							{lbl(t("overlay.stroke_width"))}
							<input
								type="number"
								value={Number(p.strokeWidth ?? 0)}
								oninput={(ev: Event) =>
									mutateElement((el) => {
										el.props.strokeWidth = Number(
											(ev.target as HTMLInputElement).value,
										);
									})
								}
							/>
						</label>
						{p.shape !== "line" ? bindingRow(e, "fill") : null}
					</>
				) : null}

				{e.type === "image" ? (
					<label class="ov-field">
						{lbl(t("overlay.asset"))}
						<select
							value={String(e.props.assetId ?? "")}
							onchange={(ev: Event) =>
								mutateElement((el) => {
									el.props.assetId = (ev.target as HTMLSelectElement).value;
								})
							}
						>
							<option value="">—</option>
							{state.project.assets.map((a: Asset) => (
								<option key={a.id} value={a.id}>
									{a.filename}
								</option>
							))}
						</select>
					</label>
				) : null}

				<div class="ov-danger">
					<Button
						label={t("overlay.delete")}
						class="ov-danger-btn"
						onclick={() => deleteElement(e.id)}
					/>
				</div>
			</div>
		</Card>
	);
}

function bindingRow(e: OverlayElement, prop: string): m.Vnode {
	const key = "props." + prop;
	const binding = e.bindings[key];
	return (
		<label class="ov-field">
			{lbl(t("overlay.binding") + " (" + prop + ")")}
			<select
				value={binding ? binding.variableId : ""}
				onchange={(ev: Event) => {
					const id = (ev.target as HTMLSelectElement).value;
					mutateElement((el) => {
						if (id) el.bindings[key] = { kind: "variable", variableId: id };
						else delete el.bindings[key];
					});
				}}
			>
				<option value="">{t("overlay.no_binding")}</option>
				{state.project.variables.map((v: Variable) => (
					<option key={v.id} value={v.id}>
						{v.name}
					</option>
				))}
			</select>
		</label>
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
				<Button
					label={t("overlay.rotate")}
					onclick={() => void rotateToken()}
				/>
			}
		>
			{s ? (
				<div class="ov-runtime">
					<code class="ov-url">{runtimeUrl(s)}</code>
					<Button
						label={state.copied ? t("overlay.copied") : t("overlay.copy")}
						class="ov-copy"
						onclick={() => void copyRuntimeUrl(s)}
					/>
					<Button
						label={t("overlay.export")}
						class="ov-copy"
						disabled={state.exportBusy}
						onclick={() => void exportPng(s)}
					/>
				</div>
			) : (
				<p class="muted">{t("overlay.no_selection")}</p>
			)}
		</Card>
	);
}

function assetsPanel(): m.Vnode {
	return (
		<Card title={t("overlay.assets")} class="ov-bottom">
			<label class="ov-upload">
				<input
					type="file"
					accept="image/*"
					onchange={(ev: Event) => {
						const f = (ev.target as HTMLInputElement).files?.[0];
						if (f) void uploadAsset(f);
					}}
				/>
				{t("overlay.upload")}
			</label>
			<div class="ov-asset-list">
				{state.project.assets.map((a: Asset) => (
					<span key={a.id} class="ov-asset" title={a.filename}>
						<img src={assetUrl(a)} alt={a.filename} />
						<button type="button" onclick={() => void deleteAsset(a.id)}>
							✕
						</button>
					</span>
				))}
			</div>
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
					label={t("overlay.add_shape")}
					onclick={() => addElement("shape")}
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
												oninput={(ev: Event) => (state.renameValue = (ev.target as HTMLInputElement).value)}
												onkeydown={(ev: KeyboardEvent) => {
													if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
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
													label={
														<Icon name="delete" class="role-icon" />
													}
													class="icon-link dash-delete"
													title={t("overlay.delete_scene")}
													aria-label={t("overlay.delete_scene")}
													onclick={(ev: Event) => {
														ev.stopPropagation();
														if (
															confirm(
																t(
																	"overlay.confirm_delete_scene",
																),
															)
														)
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
						{assetsPanel()}
					</div>
				</div>
			</Page>
		);
	},
};

void mountPage(() => t("overlay.title"), overlaysPage);
