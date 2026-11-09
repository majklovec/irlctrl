/*
 * The webrtc module's overlay element definitions. The WebRTC element owns its
 * rendering, inspector and server-side normalization in elements/webrtc.tsx.
 * `overlay_elements.tsx` is the browser half collected by the module manifest
 * generator; `overlay_schema.ts` re-exports it for scene validation.
 */
import type { OverlayElementDef } from "@ui/overlay/element";
import type { OverlayElementSchema } from "../../../../core/overlay_element";
import { webrtcElement } from "./elements/webrtc";

const elements: (OverlayElementDef & OverlayElementSchema)[] = [webrtcElement];

export default elements;
