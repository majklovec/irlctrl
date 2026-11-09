/*
 * Built-in overlay element definitions. Each element owns its rendering,
 * inspector and server-side normalization in one file under elements/.
 */
import type { OverlayElementDef } from "@ui/overlay/element";
import type { OverlayElementSchema } from "../../../../core/overlay_element";
import { alertsElement } from "./elements/alerts";
import { ambientElement } from "./elements/ambient";
import { chatElement } from "./elements/chat";
import { countdownElement } from "./elements/countdown";
import { counterElement } from "./elements/counter";
import { creditsElement } from "./elements/credits";
import { ellipseElement } from "./elements/ellipse";
import { featuredElement } from "./elements/featured";
import { frameElement } from "./elements/frame";
import { goalElement } from "./elements/goal";
import { groupElement } from "./elements/group";
import { iframeElement } from "./elements/iframe";
import { imageElement } from "./elements/image";
import { lineElement } from "./elements/line";
import { liveMapElement } from "./elements/live_map";
import { lowerThirdElement } from "./elements/lower_third";
import { progressElement } from "./elements/progress";
import { rectangleElement } from "./elements/rectangle";
import { socialsElement } from "./elements/socials";
import { spinWheelElement } from "./elements/spin_wheel";
import { tasksElement } from "./elements/tasks";
import { textElement } from "./elements/text";
import { videoElement } from "./elements/video";
import { weatherElement } from "./elements/weather";

const elements: (OverlayElementDef & OverlayElementSchema)[] = [
	textElement,
	rectangleElement,
	ellipseElement,
	lineElement,
	progressElement,
	imageElement,
	videoElement,
	iframeElement,
	groupElement,
	alertsElement,
	weatherElement,
	countdownElement,
	lowerThirdElement,
	frameElement,
	socialsElement,
	creditsElement,
	tasksElement,
	goalElement,
	counterElement,
	spinWheelElement,
	featuredElement,
	chatElement,
	liveMapElement,
	ambientElement,
];

export default elements;
