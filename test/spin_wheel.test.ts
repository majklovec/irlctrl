import { describe, expect, test } from "bun:test";

// The element module imports the browser i18n module, which touches
// document/window at import time — stub minimal globals before the dynamic
// import so it loads headlessly (same convention as alerts.test.ts).
(globalThis as Record<string, unknown>).document = { documentElement: {} };
// mithril's m.redraw() schedules work via requestAnimationFrame — provide one
// (synchronously) so onTrigger's redraw doesn't throw headlessly.
(globalThis as Record<string, unknown>).requestAnimationFrame = (
    fn: () => void,
) => {
    fn();
    return 0;
};
(globalThis as Record<string, unknown>).window = {
    location: { origin: "http://localhost" },
    requestAnimationFrame: (globalThis as Record<string, unknown>)
        .requestAnimationFrame,
};

const { spinWheelElement } = await import(
    "../server/pages/overlays/modules/overlay_elements/elements/spin_wheel"
);
const { DEFAULT_ALERT_PROPS } = await import(
    "../server/pages/overlays/modules/overlay_elements/elements/alerts_schema"
);
const { DEFAULT_SPIN_WHEEL_PROPS } = await import(
    "../server/pages/overlays/modules/overlay_elements/elements/spin_wheel_schema"
);
const { parseElementInput } = await import(
    "../server/pages/overlays/overlay"
);
const { overlayElementView } = await import(
    "../server/pages/overlays/frontend/overlay_render"
);
const { elementDef } = await import(
    "../server/pages/overlays/frontend/registry"
);

import type { VariableValue } from "../server/pages/overlays/overlay";
import type {
    ElementContext,
    OverlayElement,
    TriggerState,
} from "../shared/ui/overlay/element";

const el = (over: Record<string, unknown> = {}): OverlayElement => ({
    id: "w1",
    name: "wheel",
    type: "spin_wheel",
    transform: {
        x: 0,
        y: 0,
        width: 340,
        height: 340,
        rotation: 0,
        opacity: 1,
    },
    visible: true,
    locked: false,
    parentId: null,
    bindings: {},
    props: { ...DEFAULT_SPIN_WHEEL_PROPS, ...over },
});

/** A trigger-driven element that is NOT persistent (the alert element):
 * same shape as el(), different type. */
const alertEl = (): OverlayElement => ({
    ...el({}),
    id: "a1",
    name: "alert",
    type: "alert",
    props: { ...DEFAULT_ALERT_PROPS },
});

/** Editor context: no `activeTriggers` at all. */
const editorCtx = (): ElementContext => ({
    assetUrls: new Map<string, string>(),
    variables: new Map<string, VariableValue>(),
    variableNames: new Map<string, VariableValue>(),
});

/** OBS runtime context: `activeTriggers` present (empty = nothing on air). */
const runtimeCtx = (): ElementContext => ({
    ...editorCtx(),
    activeTriggers: new Map<string, TriggerState>(),
});

/** Runtime context with one active trigger for the given element id. */
const runtimeCtxActive = (id: string): ElementContext => ({
    ...editorCtx(),
    activeTriggers: new Map<string, TriggerState>([
        [
            id,
            { startedAt: Date.now() - 1000, expiresAt: Date.now() + 4000, payload: {} },
        ],
    ]),
});

describe("spin_wheel definition", () => {
    test("is registered, trigger-driven AND persistent", () => {
        const registered = elementDef("spin_wheel");
        expect(registered).toBeDefined();
        expect(registered?.persistent).toBe(true);
        expect(typeof registered?.onTrigger).toBe("function");
        expect(spinWheelElement.persistent).toBe(true);
    });
});

describe("renderer visibility (editor vs OBS runtime)", () => {
    /** The wheel's `draw` returns a stateful m.Component vnode that does not
     * expand under JSON.stringify headlessly — so assert the visibility
     * contract on the .overlay-element's children: non-empty = the element
     * is being rendered, empty = hidden. */
    const wheelHasContent = (ctx: ElementContext): boolean =>
        (overlayElementView(el(), ctx).children ?? []).some((c: unknown) =>
            c !== null,
        );

    test("renders in the editor (no live trigger state)", () => {
        expect(wheelHasContent(editorCtx())).toBe(true);
    });

    test("renders at runtime with NO trigger on air (persistent)", () => {
        // this is the reported bug: the final overlay used to render the
        // element as an empty box until a trigger fired
        expect(wheelHasContent(runtimeCtx())).toBe(true);
    });

    test("renders at runtime while its trigger is active", () => {
        expect(wheelHasContent(runtimeCtxActive("w1"))).toBe(true);
    });

    test("a non-persistent trigger element (alert) is still hidden when idle", () => {
        const json = JSON.stringify(overlayElementView(alertEl(), runtimeCtx()));
        expect(json).not.toContain("overlay-alert");
    });

    test("…and shows once its trigger is active", () => {
        const json = JSON.stringify(
            overlayElementView(alertEl(), runtimeCtxActive("a1")),
        );
        expect(json).toContain("overlay-alert");
    });
});

describe("spin_wheel onTrigger()", () => {
    if (typeof spinWheelElement.onTrigger !== "function")
        throw new Error("spin_wheel is trigger-driven and must expose onTrigger");
    const onTrigger = spinWheelElement.onTrigger;

    test("claims the trigger only for its own event", () => {
        expect(onTrigger(el(), "spin", {}, editorCtx())).toBe(
            DEFAULT_SPIN_WHEEL_PROPS.duration,
        );
        expect(onTrigger(el({ event: "custom" }), "spin", {}, editorCtx())).toBe(
            undefined,
        );
        expect(
            onTrigger(el({ event: "custom" }), "custom", {}, editorCtx()),
        ).toBe(DEFAULT_SPIN_WHEEL_PROPS.duration);
    });

    test("rejects a wheel with no prizes", () => {
        expect(onTrigger(el({ prizes: [] }), "spin", {}, editorCtx())).toBe(
            undefined,
        );
    });
});

describe("server-side element normalization (PUT round-trip)", () => {
    const norm = (over: Record<string, unknown> = {}): {
        prizes: string[];
    } =>
        (parseElementInput({ ...el(over) }) as unknown as {
            props: { prizes: string[] };
        }).props;

    test("keeps blank prizes (in-progress rows from the editor)", () => {
        expect(norm({ prizes: ["Prize 1", "Prize 2", ""] }).prizes).toEqual([
            "Prize 1",
            "Prize 2",
            "",
        ]);
    });

    test("caps at 24 prizes", () => {
        const many = Array.from({ length: 30 }, (_, i) => `P${i}`);
        expect(norm({ prizes: many }).prizes.length).toBe(24);
    });
});
