/*
 * Overlay element schema registry: every `OverlayElementSchema` the modules
 * contribute (`<module>/overlay_schema.ts`, collected into
 * generated/overlay_schemas.ts by scripts/gen_modules.ts), keyed by type.
 * The scene normaliser in shared/overlay.ts validates element types and
 * props through this map — the core names no element type.
 */
import type { OverlayElementSchema } from "../../core/overlay_element";
import SCHEMA_MANIFEST from "../../../generated/overlay_schemas";

function isSchema(value: unknown): value is OverlayElementSchema {
    if (typeof value !== "object" || value === null) return false;
    const s = value as Record<string, unknown>;
    return (
        typeof s.type === "string" &&
        s.type !== "" &&
        typeof s.defaultProps === "object" &&
        s.defaultProps !== null &&
        typeof s.normalizeProps === "function"
    );
}

const byType = new Map<string, OverlayElementSchema>();
for (const contribution of SCHEMA_MANIFEST as unknown[]) {
    const list = Array.isArray(contribution) ? contribution : [contribution];
    for (const schema of list) {
        if (!isSchema(schema))
            throw new Error("overlay element schema: not a valid registration");
        if (byType.has(schema.type))
            throw new Error(`overlay element schema: duplicate type ${schema.type}`);
        byType.set(schema.type, schema);
    }
}

export const overlayElementSchemas: ReadonlyMap<string, OverlayElementSchema> =
    byType;

export const overlayElementSchema = (
    type: string,
): OverlayElementSchema | undefined => byType.get(type);
