/** @jsx m */
/*
 * Shared overlay element renderer. Used by BOTH the editor preview and the
 * OBS runtime page so positions are pixel-identical: one function, one style
 * model (absolute scene coordinates, CSS px at 1:1 when unscaled).
 *
 * This file is intentionally thin — it knows HOW to wrap and position an
 * element, not WHAT one is. Every concrete element implements
 * `OverlayElementDef` contributed by a module and is looked up via the
 * registry; no element-specific code lives here.
 */
import m from "mithril";
import type { Vnode } from "mithril";
import type { OverlayElement } from "../../../../shared/overlay";
import { overlayElementSchema } from "../../../../shared/overlay_elements";
import {
	assetUrl,
	elementStyle,
	resolveElement,
	resolveElementProps,
} from "../../../../shared/ui/overlay/element";
export { assetUrl, elementStyle, resolveElement, resolveElementProps };
export type {
	CSS,
	ElementContext,
} from "../../../../shared/ui/overlay/element";
import { elementDef } from "../../../../shared/ui/overlay/registry";
import type { ElementContext } from "../../../../shared/ui/overlay/element";

/** Render one element (content + positioning) for editor and runtime.
 * Each element is resolved against its variable bindings ONCE here; both the
 * positioning style and the element's `draw` receive the resolved element so
 * bound props/transform/visible render identically in the editor and OBS.
 * Unknown element types resolve to no definition and render as an empty
 * (invisible) placeholder — core code never branches on element type. */
export function overlayElementView(
	element: OverlayElement,
	ctx: ElementContext,
): Vnode {
	const def = elementDef(element.type);
	const resolved = {
		...element,
		...resolveElement(element, ctx.variables),
	};
	const content = def ? def.draw(resolved, ctx) : null;
	return m(
		".overlay-element",
		{
			key: element.id,
			"data-element": element.id,
			style: elementStyle(resolved),
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
		elements
			.filter((e) => overlayElementSchema(e.type)?.container)
			.map((e) => e.id),
	);
	return elements
		.filter((e) => !groups.has(e.id))
		.map((el) => overlayElementView(el, ctx));
}
