/*
 * The built-in overlay elements (browser half): one file per element under
 * elements/, each fulfilling `OverlayElementDef`; their schemas are in
 * overlay_schema.ts.
 */
import { alertsElement } from "./elements/alerts";
import { ellipseElement } from "./elements/ellipse";
import { groupElement } from "./elements/group";
import { iframeElement } from "./elements/iframe";
import { imageElement } from "./elements/image";
import { lineElement } from "./elements/line";
import { progressElement } from "./elements/progress";
import { rectangleElement } from "./elements/rectangle";
import { textElement } from "./elements/text";

export default [
	textElement,
	rectangleElement,
	ellipseElement,
	lineElement,
	progressElement,
	imageElement,
	iframeElement,
	groupElement,
	alertsElement,
];
