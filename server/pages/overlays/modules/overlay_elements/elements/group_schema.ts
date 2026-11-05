/*
 * Group element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * group.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/** A group has no props of its own; it exists to parent other elements. */
export const groupSchema: OverlayElementSchema = {
    type: "group",
    defaultProps: {},
    container: true,
    normalizeProps: () => ({}),
};
