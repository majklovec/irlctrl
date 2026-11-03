import { describe, expect, test } from "bun:test";

// The element modules import the browser i18n module, which touches
// document/window at import time — stub minimal globals before the dynamic
// import so the registry loads headlessly.
(globalThis as Record<string, unknown>).document = { documentElement: {} };
(globalThis as Record<string, unknown>).window = {
    location: { origin: "http://localhost" },
};

const { elementRegistry, elementDef } = await import(
    "../shared/ui/overlay/registry"
);
const { lineFlipFromDelta } = await import(
    "../server/modules/overlay_elements/elements/line"
);
const { resolveElement, resolveElementProps, elementStyle } = await import(
    "../shared/ui/overlay/element"
);
const { DEFAULT_ALERT_PROPS } = await import(
    "../server/modules/overlay_elements/overlay_schema"
);

import {
    type OverlayElement,
    type OverlayElementType,
    type VariableValue,
} from "../shared/overlay";

const baseElement = (
    type: OverlayElementType,
    props: Record<string, unknown>,
): OverlayElement => ({
    id: "el-1",
    name: "el",
    type,
    transform: { x: 0, y: 0, width: 100, height: 50, rotation: 0, opacity: 1 },
    visible: true,
    locked: false,
    parentId: null,
    bindings: {},
    props,
});

const ctx = () => ({
    assetUrls: new Map<string, string>(),
    variables: new Map(),
    variableNames: new Map(),
});

const WELL_FORMED: Array<[OverlayElementType, Record<string, unknown>]> = [
    ["text", { text: "hi", fontSize: 48, color: "#ffffff" }],
    ["image", { libraryAssetId: "a1" }],
    [
        "rectangle",
        { fill: "#3b82f6", stroke: "#000000", strokeWidth: 2, radius: 4 },
    ],
    ["ellipse", { fill: "#3b82f6", stroke: "#000000", strokeWidth: 2 }],
    ["line", { stroke: "#3b82f6", strokeWidth: 4 }],
    [
        "progress",
        { value: 40, fill: "#22c55e", background: "#e5e7eb", radius: 6 },
    ],
    ["group", {}],
    ["iframe", { url: "https://example.com" }],
    ["chat", { url: "https://example.com/chat" }],
    ["alert", { ...DEFAULT_ALERT_PROPS }],
];

describe("element registry contract", () => {
    test("the browser registry and the schema registry cover the same module-contributed types", async () => {
        const { overlayElementSchemas } = await import(
            "../shared/overlay_elements"
        );
        const defTypes = [...elementRegistry.keys()].sort();
        expect(defTypes).toEqual([...overlayElementSchemas.keys()].sort());
        expect(defTypes.length).toBeGreaterThanOrEqual(8);
        for (const [type, def] of elementRegistry) {
            expect(def.type).toBe(type);
            expect(elementDef(type)).toBe(def);
            // the browser half seeds new elements from the schema's defaults
            expect(def.defaultProps).toEqual(
                overlayElementSchemas.get(type)!.defaultProps as Record<
                    string,
                    unknown
                >,
            );
        }
    });

    test("handle modes are structural: line = endpoints, others = box/none", () => {
        expect(elementDef("line")!.handles).toBe("endpoints");
        expect(elementDef("rectangle")!.handles).toBe("box");
        expect(elementDef("ellipse")!.handles).toBe("box");
        expect(elementDef("progress")!.handles).toBe("box");
        expect(elementDef("text")!.handles).toBe("box");
        expect(elementDef("image")!.handles).toBe("box");
        expect(elementDef("group")!.handles).toBe("none");
        expect(elementDef("alert")!.handles).toBe("box");
    });

    test("well-formed elements pass their validate()", () => {
        for (const [type, props] of WELL_FORMED) {
            const def = elementDef(type)!;
            expect(def.validate(baseElement(type, { ...props }))).toEqual([]);
        }
    });

    test("validators report problems on malformed elements", () => {
        expect(
            elementDef("line")!.validate(
                baseElement("line", { strokeWidth: 0 }),
            ),
        ).not.toEqual([]);
        expect(
            elementDef("text")!.validate(baseElement("text", { text: 7 })),
        ).not.toEqual([]);
        expect(
            elementDef("image")!.validate(baseElement("image", {})),
        ).not.toEqual([]);
        expect(
            elementDef("progress")!.validate(
                baseElement("progress", { value: 140 }),
            ),
        ).not.toEqual([]);
    });

    test("every element publishes a draw() returning a Vnode (group: none)", () => {
        for (const [type, props] of WELL_FORMED) {
            const def = elementDef(type)!;
            const vnode = def.draw(baseElement(type, { ...props }), ctx());
            if (type === "group") expect(vnode).toBeNull();
            else expect(vnode).toBeTypeOf("object");
        }
    });

    test("draw() renders the bound value when given a resolved element", () => {
        const variables = new Map<string, VariableValue>([
            ["v1", "bound text"],
        ]);
        const el = baseElement("text", { text: "static" });
        el.bindings = { "props.text": { kind: "variable", variableId: "v1" } };
        const resolved = { ...el, ...resolveElement(el, variables) };
        const vnode = elementDef("text")!.draw(resolved, ctx());
        expect(JSON.stringify(vnode)).toContain("bound text");
        // an unresolved element still shows its raw prop value
        const raw = elementDef("text")!.draw(el, ctx());
        expect(JSON.stringify(raw)).toContain("static");
    });

    test("progress draw() sizes the fill from value and clamps out-of-range", () => {
        const at = (value: number) =>
            JSON.stringify(
                elementDef("progress")!.draw(
                    baseElement("progress", { value }),
                    ctx(),
                ),
            );
        expect(at(40)).toContain("40%");
        // values outside 0–100 are clamped so the fill can't overflow the track
        expect(at(140)).toContain("100%");
        expect(at(-5)).toContain("0%");
    });

    test("resolveElement(): props.* replaces the raw prop (no coercion)", () => {
        const variables = new Map<string, VariableValue>([
            ["v1", "hello"],
            ["v2", 42],
        ]);
        const el = baseElement("text", { text: "static", fontSize: 48 });
        el.bindings = {
            "props.text": { kind: "variable", variableId: "v1" },
            "props.fontSize": { kind: "variable", variableId: "v2" },
        };
        const r = resolveElement(el, variables);
        expect(r.props.text).toBe("hello");
        expect(r.props.fontSize).toBe(42);
        // unbound props and the element base are untouched
        expect(r.props).not.toBe(el.props);
        expect(el.props.text).toBe("static");
        expect(r.transform).toEqual(el.transform);
        expect(r.visible).toBe(true);
    });

    test("resolveElement(): transform.* coerces to finite numbers", () => {
        const variables = new Map<string, VariableValue>([
            ["v1", "10"],
            ["v2", "0.5"],
        ]);
        const el = baseElement("text", { text: "x" });
        el.bindings = {
            "transform.x": { kind: "variable", variableId: "v1" },
            "transform.opacity": { kind: "variable", variableId: "v2" },
        };
        const r = resolveElement(el, variables);
        expect(r.transform.x).toBe(10);
        expect(r.transform.opacity).toBe(0.5);
        // only the bound fields change
        expect(r.transform.y).toBe(el.transform.y);
    });

    test("resolveElement(): bad transform values are ignored", () => {
        const variables = new Map<string, VariableValue>([
            ["vNaN", "not-a-number"],
            ["vInf", Infinity],
            ["vOpBig", 5], // opacity > 1
            ["vOpNeg", -1], // opacity < 0
        ]);
        const el = baseElement("text", { text: "x" });
        el.bindings = {
            "transform.x": { kind: "variable", variableId: "vNaN" },
            "transform.width": { kind: "variable", variableId: "vInf" },
            "transform.opacity": { kind: "variable", variableId: "vOpBig" },
        };
        const r = resolveElement(el, variables);
        expect(r.transform.x).toBe(el.transform.x);
        expect(r.transform.width).toBe(el.transform.width);
        expect(r.transform.opacity).toBe(el.transform.opacity);
        // negative opacity is rejected too
        el.bindings = {
            "transform.opacity": { kind: "variable", variableId: "vOpNeg" },
        };
        expect(resolveElement(el, variables).transform.opacity).toBe(
            el.transform.opacity,
        );
    });

    test("resolveElement(): visible binding follows variable truthiness", () => {
        const variables = new Map<string, VariableValue>([
            ["v1", ""],
            ["v2", "show me"],
            ["v3", 0],
            ["v4", 7],
        ]);
        const el = baseElement("text", { text: "x" });
        const vis = (id: string) => {
            el.bindings = { visible: { kind: "variable", variableId: id } };
            return resolveElement(el, variables).visible;
        };
        expect(vis("v1")).toBe(false); // empty string
        expect(vis("v2")).toBe(true);
        expect(vis("v3")).toBe(false); // zero
        expect(vis("v4")).toBe(true);
        // no binding at all keeps the raw flag
        el.bindings = {};
        el.visible = false;
        expect(resolveElement(el, variables).visible).toBe(false);
    });

    test("resolveElement(): unknown paths and missing variables are ignored", () => {
        const variables = new Map<string, VariableValue>([["v1", 123]]);
        const el = baseElement("text", { text: "x" });
        el.bindings = {
            bogus: { kind: "variable", variableId: "v1" },
            "props.": { kind: "variable", variableId: "v1" },
            "transform.": { kind: "variable", variableId: "v1" },
            "props.text": { kind: "variable", variableId: "missing" },
        };
        const r = resolveElement(el, variables);
        expect(r).toEqual({
            props: el.props,
            transform: el.transform,
            visible: true,
        });
    });

    test("elementStyle() reflects resolved transform and visibility", () => {
        const el = baseElement("text", { text: "x" });
        el.transform = {
            x: 5,
            y: 10,
            width: 100,
            height: 50,
            rotation: 45,
            opacity: 0.5,
        };
        el.visible = false;
        const style = elementStyle(el) as Record<string, string>;
        expect(style.left).toBe("5px");
        expect(style.top).toBe("10px");
        expect(style.transform).toBe("rotate(45deg)");
        expect(style.opacity).toBe("0.5");
        expect(style.visibility).toBe("hidden");
    });

    test("resolveElementProps() keeps returning the prop half only", () => {
        const variables = new Map<string, VariableValue>([["v1", "bound"]]);
        const el = baseElement("text", { text: "static" });
        el.bindings = { "props.text": { kind: "variable", variableId: "v1" } };
        expect(resolveElementProps(el, variables).text).toBe("bound");
    });

    test("lineFlipFromDelta: only opposite-sign components mirror the diagonal", () => {
        // same-sign (incl. both backward) = forward diagonal
        expect(lineFlipFromDelta(10, 5)).toBe(false);
        expect(lineFlipFromDelta(-10, -5)).toBe(false);
        // opposite signs = mirrored diagonal
        expect(lineFlipFromDelta(-10, 5)).toBe(true);
        expect(lineFlipFromDelta(10, -5)).toBe(true);
        // a pure-axis drag is a box edge: no ambiguity
        expect(lineFlipFromDelta(10, 0)).toBe(false);
        expect(lineFlipFromDelta(-10, 0)).toBe(false);
    });

    test("line draw runs along the box diagonal set by props.flip", () => {
        const el = baseElement("line", { flip: false });
        el.transform = {
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            rotation: 0,
            opacity: 1,
        };
        const angleOf = (e: OverlayElement): number => {
            const vnode = elementDef("line")!.draw(e, ctx()) as {
                attrs?: { style?: Record<string, string> };
            };
            const tr = vnode.attrs?.style?.transform ?? "";
            const match = /rotate\((-?[\d.]+)deg\)/.exec(tr);
            return Number(match?.[1]);
        };
        // forward diagonal: top-left → bottom-right (positive slope on screen)
        expect(angleOf(el)).toBeCloseTo(
            Math.atan2(50, 100) * (180 / Math.PI),
            3,
        );
        el.props.flip = true;
        // mirrored diagonal: top-right → bottom-left (negative slope)
        expect(angleOf(el)).toBeCloseTo(
            -Math.atan2(50, 100) * (180 / Math.PI),
            3,
        );
    });

    test("unknown / legacy types resolve to undefined", () => {
        expect(elementDef("banana")).toBeUndefined();
        expect(elementDef("shape")).toBeUndefined();
    });
});
