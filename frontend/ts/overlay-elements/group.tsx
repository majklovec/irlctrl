/** @jsx m */
import type { Children, Vnode } from "mithril";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "./core";

// A group is a container: it renders no content of its own (children are the
// elements that set `parentId` to it) and shows no resize handles — it is
// edited by selecting and moving its children.
function draw(_element: OverlayElement, _ctx: ElementContext): Children {
	return null;
}

function editForm(_props: ElementProps): Children {
	return null;
}

function validate(_element: OverlayElement): string[] {
	// groups are always valid: they carry no per-element props
	return [];
}

export const groupElement: OverlayElementDef = {
	type: "group",
	defaultProps: {},
	defaultSize: { width: 0, height: 0 },
	draw,
	editForm,
	validate,
	handles: "none",
};
