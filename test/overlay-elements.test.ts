import { describe, expect, test } from "bun:test";

// The element modules import the browser i18n module, which touches
// document/window at import time — stub minimal globals before the dynamic
// import so the registry loads headlessly.
(globalThis as Record<string, unknown>).document = { documentElement: {} };
(globalThis as Record<string, unknown>).window = {
    location: { origin: "http://localhost" },
};

const { elementRegistry, elementDef } = await import(
    "../frontend/ts/overlay-elements/registry"
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

const ctx = () => ({ assetUrls: new Map<string, string>(), variables: new Map() });

const WELL_FORMED: Array<[OverlayElementType, Record<string, unknown>]> = [
    ["text", { text: "hi", fontSize: 48, color: "#ffffff" }],
    ["image", { assetId: "a1" }],
    [
        "rectangle",
        { fill: "#3b82f6", stroke: "#000000", strokeWidth: 2, radius: 4 },
    ],
    ["ellipse", { fill: "#3b82f6", stroke: "#000000", strokeWidth: 2 }],
    ["line", { stroke: "#3b82f6", strokeWidth: 4 }],
    ["group", {}],
];

describe("element registry contract", () => {
    test("every schema type is registered exactly once and self-consistent", () => {
        expect(Object.keys(elementRegistry).sort()).toEqual([
            "ellipse",
            "group",
            "image",
            "line",
            "rectangle",
            "text",
        ]);
        for (const def of Object.values(elementRegistry)) {
            expect(elementRegistry[def.type]).toBe(def);
        }
    });

    test("handle modes are structural: line = endpoints, others = box/none", () => {
        expect(elementDef("line")!.handles).toBe("endpoints");
        expect(elementDef("rectangle")!.handles).toBe("box");
        expect(elementDef("ellipse")!.handles).toBe("box");
        expect(elementDef("text")!.handles).toBe("box");
        expect(elementDef("image")!.handles).toBe("box");
        expect(elementDef("group")!.handles).toBe("none");
    });

    test("well-formed elements pass their validate()", () => {
        for (const [type, props] of WELL_FORMED) {
            const def = elementDef(type)!;
            expect(def.validate(baseElement(type, { ...props }))).toEqual([]);
        }
    });

    test("validators report problems on malformed elements", () => {
        expect(
            elementDef("line")!.validate(baseElement("line", { strokeWidth: 0 })),
        ).not.toEqual([]);
        expect(
            elementDef("text")!.validate(baseElement("text", { text: 7 })),
        ).not.toEqual([]);
        expect(
            elementDef("image")!.validate(baseElement("image", {})),
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

    test("draw() honors variable bindings resolved through the context", () => {
        const variables = new Map<string, VariableValue>([
            ["v1", "bound text"],
        ]);
        const el = baseElement("text", { text: "static" });
        el.bindings = { "props.text": { kind: "variable", variableId: "v1" } };
        const vnode = elementDef(
            "text",
        )!.draw(el, { assetUrls: new Map(), variables });
        expect(JSON.stringify(vnode)).toContain("bound text");
    });

    test("unknown / legacy types resolve to undefined", () => {
        expect(elementDef("video")).toBeUndefined();
        expect(elementDef("shape")).toBeUndefined();
    });
});
