import m from "mithril";
import {
	closeToolMenus,
	deleteElement,
	overlay,
	redo,
	saveOverlayElements,
	selElement,
	snapshot,
	state,
	undo,
} from "../overlay_store";

export function onKey(ev: KeyboardEvent): void {
	const tag = (ev.target as HTMLElement | null)?.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	// Escape closes an open toolbar menu before it reaches the element
	// shortcuts (the scrim is not focusable, so it never gets keydowns itself).
	if (ev.key === "Escape") {
		if (state.catalogOpen) {
			ev.preventDefault();
			closeToolMenus();
		}
		return;
	}
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
		const s = overlay();
		if (s) void saveOverlayElements(s);
		m.redraw();
	}
}
