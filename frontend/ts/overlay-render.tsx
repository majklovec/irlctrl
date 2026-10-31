/** @jsx m */
/*
 * Shared overlay element renderer. Used by BOTH the editor preview and the
 * OBS runtime page so positions are pixel-identical: one function, one style
 * model (absolute scene coordinates, CSS px at 1:1 when unscaled).
 *
 * This file is intentionally thin — it knows HOW to wrap and position an
 * element, not WHAT one is. Every concrete element implements
 * `OverlayElementDef` in `./overlay-elements/` and is looked up via the
 * registry; no element-specific code lives here.
 */
import m from "mithril";
import type { Vnode } from "mithril";
import type { OverlayElement } from "../../shared/overlay";
import {
	assetUrl,
	elementStyle,
	resolveElementProps,
} from "./overlay-elements/core";
export { assetUrl, elementStyle, resolveElementProps };
export type { CSS, ElementContext } from "./overlay-elements/core";
import { elementDef } from "./overlay-elements/registry";
import type { ElementContext } from "./overlay-elements/core";

/** Render one element (content + positioning) for editor and runtime.
 * Unknown element types resolve to no definition and render as an empty
 * (invisible) placeholder — core code never branches on element type. */
export function overlayElementView(
	element: OverlayElement,
	ctx: ElementContext,
): Vnode {
	const def = elementDef(element.type);
	const content = def ? def.draw(element, ctx) : null;
	return m(
		".overlay-element",
		{
			key: element.id,
			"data-element": element.id,
			style: elementStyle(element),
		},
		content,
	);
}

/** All elements of a scene, back to front. Groups render after (above) so
 * their children — drawn in absolute canvas space — stay selectable. */
export function sceneElementsView(
	elements: OverlayElement[],
	ctx: ElementContext,
): Vnode[] {
	const groups = new Set(
		elements.filter((e) => e.type === "group").map((e) => e.id),
	);
	return elements
		.filter((e) => !groups.has(e.id))
		.map((el) => overlayElementView(el, ctx));
}
