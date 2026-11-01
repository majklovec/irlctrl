/*
 * Browser-side overlay element registry: every `OverlayElementDef` the
 * modules contribute (`<module>/overlay_elements.tsx`, collected into
 * generated/overlay_elements.ts by scripts/gen_modules.ts), keyed by type.
 * The editor's toolbar, inspector and canvas and the runtime page resolve
 * elements only through this module.
 */
import MANIFEST from "../../../generated/overlay_elements";
import type { OverlayElementDef } from "./element";

const byType = new Map<string, OverlayElementDef>();
for (const contribution of MANIFEST as unknown[]) {
    const list = Array.isArray(contribution) ? contribution : [contribution];
    for (const def of list as OverlayElementDef[]) {
        if (typeof def?.type !== "string" || typeof def.draw !== "function")
            throw new Error("overlay element: not a valid registration");
        if (byType.has(def.type))
            throw new Error(`overlay element: duplicate type ${def.type}`);
        byType.set(def.type, def);
    }
}

export const elementRegistry: ReadonlyMap<string, OverlayElementDef> = byType;

/** Resolve an element's definition. Unknown types (e.g. legacy data)
 * resolve to undefined — the renderer skips them, the inspector shows the
 * common fields only. */
export function elementDef(type: string): OverlayElementDef | undefined {
    return byType.get(type);
}

/** The elements offered by the editor's "add" toolbar, in display order. */
export function addableElements(): OverlayElementDef[] {
    return [...byType.values()]
        .filter((def) => def.labelKey)
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
