/*
 * Overlay element plugin contract — the half of an element that is
 * environment-free, so the control server can validate stored scenes and the
 * browser can seed new elements from the same source of truth.
 *
 * A module contributes schemas by default-exporting an array of them from
 * `<module>/overlay_schema.ts` (discovered into generated/overlay_schemas.ts
 * by scripts/gen_modules.ts). The browser half — rendering and the inspector
 * form — is `OverlayElementDef` in shared/ui/overlay/element.ts, contributed
 * from `<module>/overlay_elements.tsx`.
 */

/** Defensive readers over a raw props record; every returned value is safe to store. */
export interface PropReaders {
    /** Finite number within [min, max], else `fallback`. */
    num(key: string, fallback: number, min: number, max: number): number;
    /** `#rrggbb` colour (lower-cased), else `fallback`. */
    hex(key: string, fallback: string): string;
    /** String clipped to `max` characters, else `fallback`. */
    str(key: string, fallback: string, max?: number): string;
    /** One of `allowed`, else `fallback`. */
    oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T;
    /** `true` only for a boolean true. */
    bool(key: string): boolean;
}

export interface OverlayElementSchema {
    /** Stable type id, stored in scenes (`element.type`); unique across modules. */
    readonly type: string;
    /** Props of a freshly created element. */
    readonly defaultProps: Readonly<Record<string, unknown>>;
    /** Other elements may nest under this one (`parentId`). */
    readonly container?: boolean;
    /**
     * Props holding the id of a file in the user's ASSET LIBRARY (the
     * server-side asset manager, stored on disk). Not validated at scene
     * level — the bytes resolve at render time (the runtime page through
     * its token-scoped file endpoint, the editor through the session one).
     */
    readonly serverAssetProps?: readonly string[];
    /**
     * Coerce stored props to valid values. The core keeps every unknown key
     * (forward compatibility) and only passes the record through; return the
     * known keys with safe values.
     */
    normalizeProps(
        props: Readonly<Record<string, unknown>>,
        read: PropReaders,
    ): Record<string, unknown>;
}
