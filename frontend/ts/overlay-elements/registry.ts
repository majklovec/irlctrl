/*
 * Element registry — the single lookup the core (renderer + editor) uses to
 * resolve an element's definition. Adding a new element type means creating
 * its module and registering it here; the core files never change.
 */
import type { OverlayElementType } from "../../../shared/overlay";
import type { OverlayElementDef } from "./core";
import { textElement } from "./text";
import { imageElement } from "./image";
import { rectangleElement } from "./rectangle";
import { ellipseElement } from "./ellipse";
import { lineElement } from "./line";
import { iframeElement } from "./iframe";
import { chatElement } from "./chat";
import { groupElement } from "./group";

export const elementRegistry: Record<OverlayElementType, OverlayElementDef> = {
	text: textElement,
	image: imageElement,
	rectangle: rectangleElement,
	ellipse: ellipseElement,
	line: lineElement,
	iframe: iframeElement,
	chat: chatElement,
	group: groupElement,
};

/** Resolve an element's definition. Unknown types (e.g. legacy data)
 * resolve to undefined — the renderer skips them, the inspector shows the
 * common fields only. */
export function elementDef(type: string): OverlayElementDef | undefined {
	return elementRegistry[type as OverlayElementType];
}
