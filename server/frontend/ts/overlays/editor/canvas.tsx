import { elementDef } from "@ui/overlay/registry";
import m from "mithril";
import type {
	OverlayElement,
	Scene,
	Transform,
} from "../../../../../shared/overlay";
import {
	elementStyle,
	resolveElement,
	sceneElementsView,
} from "../overlay_render";
import type { Drag } from "../overlay_store";
import {
	ctx,
	resolvedTransform,
	saveSceneElements,
	scene,
	selElement,
	selectElement,
	snapshot,
	startInlineEdit,
	state,
	stopInlineEdit,
	undo,
} from "../overlay_store";

export function toScenePoint(ev: MouseEvent): { x: number; y: number } {
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
export function applySnap(
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
			if (o.id === e.id) continue;
			// snap to the RESOLVED geometry so bound/hidden peers snap where shown
			const rt = resolveElement(o, ctx().variables);
			if (!rt.visible) continue;
			xTargets.push(rt.transform.x, rt.transform.x + rt.transform.width);
			yTargets.push(rt.transform.y, rt.transform.y + rt.transform.height);
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

export function startDrag(
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
		start: { ...resolvedTransform(e) },
		moved: false,
	};
	snapshot();
	window.addEventListener("mousemove", onDrag);
	window.addEventListener("mouseup", endDrag);
	m.redraw();
}

export function onDrag(ev: MouseEvent): void {
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
		let x = h.includes("w") ? st.x + st.width - width : st.x;
		let y = h.includes("n") ? st.y + st.height - height : st.y;
		// Snap the new box's edges/center to the canvas + other elements,
		// exactly like moving (applySnap mutates the transform in place).
		const snapped = { ...st, x, y, width, height };
		const { gx, gy } = applySnap(e, snapped);
		state.snapX = gx;
		state.snapY = gy;
		x = snapped.x;
		y = snapped.y;
		let nw = snapped.width;
		let nh = snapped.height;
		// Snapping can shrink the box (two edges landing on one target) —
		// re-clamp the size, keeping the same anchored edge.
		if (nw < MIN) {
			nw = MIN;
			if (h.includes("w")) x = x + snapped.width - nw;
		}
		if (nh < MIN) {
			nh = MIN;
			if (h.includes("n")) y = y + snapped.height - nh;
		}
		e.transform = {
			...st,
			x: Math.round(x),
			y: Math.round(y),
			width: Math.round(nw),
			height: Math.round(nh),
		};
		m.redraw();
		return;
	}
	// Line: drag one endpoint, the other stays fixed. All math happens in the
	// box's unrotated frame (the rotation is constant during the drag). The
	// server rejects negative width/height, so the box is kept in min/abs
	// form — the line runs along one of the box diagonals; which one is
	// recorded in props.flip (the drag delta's X sign decides).
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
	// new box: fixed corner + pointer corner, normalized to min/abs.
	// The delta's sign combination decides which diagonal the line runs
	// along (true = top-right → bottom-left, the "backward" diagonal).
	const width = Math.abs(ux);
	const height = Math.abs(uy);
	elementDef(e.type)?.onEndpointDrag?.(e, ux, uy);
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

export function endDrag(): void {
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

export function canvasArea(): m.Vnode {
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
						// Zoom via the CSS `zoom` property, NOT `transform: scale()`.
						// A transform promotes the canvas (and any <iframe> inside it,
						// e.g. an embedded page) to a GPU-composited layer, which on
						// real-GPU Chromium/CEF paints an opaque white backing behind the
						// iframe — a solid white box. `zoom` scales layout without creating
						// a composited layer, so iframe elements stay transparent. The
						// (clientX/Y - rect) / state.zoom math below is unaffected because
						// getBoundingClientRect() already reflects `zoom`.
						zoom: state.zoom,
						// exposed to CSS so .ov-handle can counter-scale and keep
						// a constant on-screen size regardless of zoom
						"--ov-zoom": String(state.zoom),
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
						{s
							? sceneElementsView(
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
							: null}
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
								style={elementStyle(resolveElement(el, ctx().variables))}
								onmousedown={(ev: Event) =>
									startDrag(ev as MouseEvent, el.id, "move")
								}
							>
								{elementDef(el.type)?.handles === "endpoints"
									? // endpoint elements (lines) get two endpoint
										// handles (A = top-left corner, B =
										// bottom-right corner of the box) — they can
										// never present the box's 8 resize handles
										(["a", "b"] as const).map((h) => (
											<span
												key={h}
												class={"ov-line-end ov-line-" + h}
												onmousedown={(ev: Event) =>
													startDrag(ev as MouseEvent, el.id, "line", h)
												}
											/>
										))
									: elementDef(el.type)?.handles === "box"
										? ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => (
												<span
													key={h}
													class={"ov-handle ov-" + h}
													onmousedown={(ev: Event) =>
														startDrag(ev as MouseEvent, el.id, "resize", h)
													}
												/>
											))
										: null}
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
export function inlineTextEdit(
	elementId: string,
	s: Scene | undefined,
): m.Children {
	const e = s?.elements.find((x) => x.id === elementId);
	const inline = e && elementDef(e.type)?.inlineEdit;
	if (!e || !inline) return null;
	// resolved props: a bound prop wins over the raw value, so the textarea
	// and its box show what's actually on screen
	const resolved = resolveElement(e, ctx().variables);
	const p = resolved.props;
	const style: Record<string, string> = {
		...inline.style(p),
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
	const value = p[inline.prop];
	return (
		<div
			class="ov-inline-edit"
			// full opacity: elementStyle() carries the element's opacity, and
			// a translucent wrapper would let the original text show through
			style={{ ...elementStyle(resolved), opacity: 1 }}
			onmousedown={(ev: MouseEvent) => ev.stopPropagation()}
		>
			<textarea
				class="ov-inline-edit-input"
				style={style}
				value={typeof value === "string" ? value : ""}
				ref={(dom: HTMLTextAreaElement | null) => dom?.focus()}
				oninput={(ev: Event) => {
					const sc = scene();
					const el = sc?.elements.find((x) => x.id === elementId);
					if (!sc || !el) return;
					el.props[inline.prop] = (ev.target as HTMLTextAreaElement).value;
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
