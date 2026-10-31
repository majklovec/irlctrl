import { describe, expect, test } from "bun:test";
import {
    DEFAULT_LINE_PROPS,
    DEFAULT_RECTANGLE_PROPS,
    DEFAULT_TEXT_PROPS,
    defaultProject,
    generateOverlayToken,
    migrateProjectBlob,
    normalizeProject,
    OVERLAY_SCHEMA_VERSION,
    overlayTokenMatches,
    parseCanvasInput,
    parseElementInput,
    parseSceneInput,
    parseVariableValueInput,
    slugify,
    type Transform,
    type Variable,
} from "../shared/overlay";
import { ApiError } from "../shared/params";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const transform = (over: Partial<Transform> = {}): Transform => ({
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    ...over,
});

const textElement = (
    over: Record<string, unknown> = {},
): Record<string, unknown> => ({
    id: "el-1",
    name: "headline",
    type: "text",
    transform: transform(),
    visible: true,
    locked: false,
    parentId: null,
    bindings: {},
    props: { text: "Hello", fontSize: 42, color: "#ffffff" },
    ...over,
});

type RawProject = {
    schemaVersion: number;
    canvas: { width: number; height: number };
    variables: unknown[];
    assets: unknown[];
    scenes: Record<string, unknown>[];
} & Record<string, unknown>;

const validV1Project = (): RawProject => ({
    schemaVersion: 1,
    canvas: { width: 1920, height: 1080 },
    variables: [],
    assets: [],
    scenes: [
        {
            id: "sc-1",
            name: "Scene 1",
            slug: "scene-1",
            elements: [textElement()],
        },
    ],
});

describe("overlay schema", () => {
    test("default project is a valid v1 project", () => {
        const project = defaultProject();
        expect(project.schemaVersion).toBe(OVERLAY_SCHEMA_VERSION);
        expect(project.canvas).toEqual({ width: 1920, height: 1080 });
        expect(project.scenes).toHaveLength(1);
        expect(project.scenes[0].slug).toBe("scene-1");
        // a fresh project must round-trip through the loader
        const loaded = migrateProjectBlob(clone(project));
        expect(loaded.project.scenes[0].id).toBe(project.scenes[0].id);
    });

    test("migrateProjectBlob accepts a v1 project and preserves unknown fields", () => {
        const raw = validV1Project();
        raw.customFlag = "keep-me";
        const scene = raw.scenes[0] as Record<string, unknown>;
        scene.customSceneField = 42;
        const el0 = (scene.elements as Record<string, unknown>[])[0];
        el0.note = "editor draft marker";

        const { project, migrated } = migrateProjectBlob(raw);
        expect(migrated).toBe(false);
        expect(project).toHaveProperty("customFlag", "keep-me");
        expect(project.scenes[0]).toHaveProperty("customSceneField", 42);
        expect(project.scenes[0].elements[0]).toHaveProperty(
            "note",
            "editor draft marker",
        );
    });

    test("migrateProjectBlob rejects unmigratable projects", () => {
        expect(() => migrateProjectBlob("nope")).toThrow("not a JSON object");
        expect(() =>
            migrateProjectBlob({ canvas: { width: 1, height: 1 } }),
        ).toThrow("no schemaVersion");
        expect(() =>
            migrateProjectBlob({ ...validV1Project(), schemaVersion: 99 }),
        ).toThrow("too old to load it");
    });

    test("token comparison is constant-time and shape-checked", () => {
        const token = generateOverlayToken();
        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(generateOverlayToken()).not.toBe(token);
        expect(overlayTokenMatches(token, token)).toBe(true);
        expect(overlayTokenMatches(token, token.slice(0, -1))).toBe(false);
        expect(overlayTokenMatches(token, "f".repeat(32))).toBe(false);
        expect(overlayTokenMatches(token, token.slice(1) + token[0])).toBe(false);
        expect(overlayTokenMatches("", "")).toBe(false);
    });

    test("slugify is URL-safe and stable for empty input", () => {
        expect(slugify("My Scene!")).toBe("my-scene");
        expect(slugify("  --weird--  ")).toBe("weird");
        expect(slugify("???")).toBe("scene");
    });

    test("normalizeProject validates and types variables", () => {
        const raw = validV1Project();
        raw.variables = [
            { id: "v1", name: "score", type: "number", value: "12" },
            { id: "v2", name: "accent", type: "color", value: "#ABCDEF" },
            { id: "v3", name: "flag", type: "boolean", value: "yes" },
            { id: "v4", name: "title", type: "string", value: 7 },
        ];
        const project = normalizeProject(raw);
        expect(project.variables[0].value).toBe(12);
        expect(project.variables[1].value).toBe("#abcdef");
        expect(project.variables[2].value).toBe(true);
        expect(project.variables[3].value).toBe("7");
    });

    test("variable normalization rejects bad names and types", () => {
        const raw = validV1Project();
        raw.variables = [{ id: "v1", name: "9lives", type: "string", value: "x" }];
        expect(() => normalizeProject(raw)).toThrow();
        raw.variables = [{ id: "v1", name: "ok_name", type: "float", value: 1 }];
        expect(() => normalizeProject(raw)).toThrow();
    });

    test("normalizeProject enforces unique slugs", () => {
        const raw = validV1Project();
        raw.scenes = [
            { id: "a", name: "A", slug: "dup", elements: [] },
            { id: "b", name: "B", slug: "dup", elements: [] },
        ];
        expect(() => normalizeProject(raw)).toThrow("duplicate scene slug dup");
    });

    test("normalizeProject preserves unknown element props (forward compatibility)", () => {
        const raw = validV1Project();
        const el = (raw.scenes[0] as { elements: Record<string, unknown>[] })
            .elements[0] as Record<string, unknown>;
        (el as Record<string, unknown>).props = {
            text: "Hi",
            fontSize: 42,
            customEffect: "glow",
        };
        const project = normalizeProject(raw);
        const props = project.scenes[0].elements[0].props;
        expect(props.customEffect).toBe("glow");
        // known text props get defaults where missing
        expect(props.fontSize).toBe(42);
        expect(props.color).toBe(DEFAULT_TEXT_PROPS.color);
    });

    test("elements must be an object and have a valid type", () => {
        expect(() => parseElementInput("x")).toThrow();
        expect(() =>
            parseElementInput({ ...textElement(), type: "video" }),
        ).toThrow();
        expect(() => parseElementInput({ ...textElement(), id: "" })).toThrow();
    });

    test("the legacy unified 'shape' type is no longer accepted", () => {
        expect(() =>
            parseElementInput({ ...textElement(), type: "shape" }),
        ).toThrow();
    });

    test("rectangle props are normalized with type-specific ranges", () => {
        const el = parseElementInput({
            ...textElement(),
            type: "rectangle",
            props: {
                fill: 5,
                stroke: "#abc",
                strokeWidth: -5,
                radius: 999999,
                customEffect: "glow",
            },
        });
        expect(el.type).toBe("rectangle");
        expect(el.props.fill).toBe(DEFAULT_RECTANGLE_PROPS.fill);
        expect(el.props.strokeWidth).toBe(DEFAULT_RECTANGLE_PROPS.strokeWidth);
        expect(el.props.radius).toBe(DEFAULT_RECTANGLE_PROPS.radius);
        // unknown keys survive normalization
        expect(el.props.customEffect).toBe("glow");
    });

    test("ellipse props are normalized with type-specific ranges", () => {
        const el = parseElementInput({
            ...textElement(),
            type: "ellipse",
            props: { fill: "#123456", strokeWidth: 7 },
        });
        expect(el.type).toBe("ellipse");
        expect(el.props.fill).toBe("#123456");
        expect(el.props.strokeWidth).toBe(7);
    });

    test("line props are normalized and in-range values kept", () => {
        const el = parseElementInput({
            ...textElement(),
            type: "line",
            props: { stroke: null, strokeWidth: 3 },
        });
        expect(el.type).toBe("line");
        expect(el.props.stroke).toBe(DEFAULT_LINE_PROPS.stroke);
        expect(el.props.strokeWidth).toBe(3);
        expect(el.props.flip).toBe(false);
    });

    test("line flip is a strict boolean (which box diagonal the line runs along)", () => {
        const el = parseElementInput({
            ...textElement(),
            type: "line",
            props: { flip: true },
        });
        expect(el.props.flip).toBe(true);
        const bad = parseElementInput({
            ...textElement(),
            type: "line",
            props: { flip: "yes" },
        });
        expect(bad.props.flip).toBe(false);
    });

    test("bindings must be variable references and target existing variables", () => {
        const raw = validV1Project();
        const el = (raw.scenes[0] as { elements: Record<string, unknown>[] })
            .elements[0] as Record<string, unknown>;
        (el as Record<string, unknown>).bindings = {
            "props.text": { kind: "variable", variableId: "v1" },
        };
        expect(() => normalizeProject(raw)).toThrow(
            "binding to unknown variable v1",
        );
        raw.variables = [{ id: "v1", name: "title", type: "string", value: "hi" }];
        const ok = normalizeProject(raw);
        expect(ok.scenes[0].elements[0].bindings["props.text"]).toEqual({
            kind: "variable",
            variableId: "v1",
        });

        // non-variable binding kinds are rejected in v1
        (el as Record<string, unknown>).bindings = {
            "props.text": { kind: "expr", expression: "1+1" },
        };
        expect(() => normalizeProject(raw)).toThrow();
    });

    test("image elements must reference existing assets", () => {
        const raw = validV1Project();
        (raw.scenes[0] as Record<string, unknown>).elements = [
            {
                ...textElement({ id: "img-1", type: "image" }),
                props: { assetId: "missing-asset" },
            },
        ];
        expect(() => normalizeProject(raw)).toThrow("missing asset");
        raw.assets = [
            {
                id: "a1",
                hash: "ab",
                mime: "image/png",
                filename: "x.png",
                dataBase64: "AAAA",
            },
        ];
        (raw.scenes[0] as Record<string, unknown>).elements = [
            {
                ...textElement({ id: "img-1", type: "image" }),
                props: { assetId: "a1" },
            },
        ];
        expect(normalizeProject(raw).scenes[0].elements[0].props.assetId).toBe(
            "a1",
        );
    });

    test("parent elements must exist, be groups, and be acyclic", () => {
        const base = () => {
            const raw = validV1Project();
            raw.variables = [];
            raw.assets = [];
            return raw;
        };

        // missing parent
        {
            const raw = base();
            (raw.scenes[0] as Record<string, unknown>).elements = [
                { ...textElement(), parentId: "ghost" },
            ];
            expect(() => normalizeProject(raw)).toThrow("missing parent");
        }

        // non-group parent
        {
            const raw = base();
            (raw.scenes[0] as Record<string, unknown>).elements = [
                textElement(),
                { ...textElement({ id: "el-2", parentId: "el-1" }) },
            ];
            expect(() => normalizeProject(raw)).toThrow("non-group parent");
        }

        // cycle
        {
            const raw = base();
            (raw.scenes[0] as Record<string, unknown>).elements = [
                {
                    id: "g1",
                    name: "g1",
                    type: "group",
                    transform: transform(),
                    visible: true,
                    locked: false,
                    parentId: "g2",
                    bindings: {},
                    props: {},
                },
                {
                    id: "g2",
                    name: "g2",
                    type: "group",
                    transform: transform(),
                    visible: true,
                    locked: false,
                    parentId: "g1",
                    bindings: {},
                    props: {},
                },
            ];
            expect(() => normalizeProject(raw)).toThrow();
        }
    });

    test("parseCanvasInput wraps errors in ApiError", () => {
        expect(parseCanvasInput({ width: 800, height: 600 })).toEqual({
            width: 800,
            height: 600,
        });
        expect(() => parseCanvasInput({ width: -1, height: 600 })).toThrow(
            ApiError,
        );
        expect(() => parseCanvasInput({ width: "90000", height: 600 })).toThrow(
            ApiError,
        );
    });

    test("parseSceneInput requires at least one field", () => {
        expect(() => parseSceneInput({})).toThrow("name, slug or elements");
        expect(parseSceneInput({ name: "New" })).toEqual({ name: "New" });
        expect(parseSceneInput({ slug: "a-b-1" })).toEqual({ slug: "a-b-1" });
        expect(() => parseSceneInput({ slug: "UPPER" })).toThrow(
            "name, slug or elements",
        );
    });

    test("parseVariableValueInput coerces by variable type", () => {
        const numVar: Variable = { id: "n", name: "n", type: "number", value: 1 };
        expect(parseVariableValueInput("42.5", numVar)).toBe(42.5);
        expect(() => parseVariableValueInput("NaN", numVar)).toThrow(ApiError);

        const colorVar: Variable = {
            id: "c",
            name: "c",
            type: "color",
            value: "#000000",
        };
        expect(parseVariableValueInput("#ABCD12", colorVar)).toBe("#abcd12");
        expect(() => parseVariableValueInput("red", colorVar)).toThrow(ApiError);

        const boolVar: Variable = {
            id: "b",
            name: "b",
            type: "boolean",
            value: false,
        };
        expect(parseVariableValueInput(1, boolVar)).toBe(true);

        const strVar: Variable = { id: "s", name: "s", type: "string", value: "x" };
        expect(parseVariableValueInput(9, strVar)).toBe("9");
        expect(parseVariableValueInput(null, strVar)).toBe("");
    });

    test("canvas size limits are enforced", () => {
        const raw = validV1Project();
        raw.canvas = { width: 9999, height: 1080 };
        expect(() => normalizeProject(raw)).toThrow("canvas");
        raw.canvas = { width: 8192, height: 16 };
        expect(normalizeProject(raw).canvas).toEqual({ width: 8192, height: 16 });
    });
});
