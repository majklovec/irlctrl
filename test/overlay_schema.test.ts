import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_PROPS } from "../server/pages/overlays/modules/overlay_elements/elements/chat_schema";
import { DEFAULT_LINE_PROPS } from "../server/pages/overlays/modules/overlay_elements/elements/line_schema";
import { DEFAULT_PROGRESS_PROPS } from "../server/pages/overlays/modules/overlay_elements/elements/progress_schema";
import { DEFAULT_RECTANGLE_PROPS } from "../server/pages/overlays/modules/overlay_elements/elements/rectangle_schema";
import { DEFAULT_TEXT_PROPS } from "../server/pages/overlays/modules/overlay_elements/elements/text_schema";
import { DEFAULT_VIDEO_PROPS } from "../server/pages/overlays/modules/overlay_elements/elements/video_schema";
import {
	cssFilterString,
	defaultOverlay,
	isMimeKind,
	migrateOverlayBlob,
	normalizeFilters,
	normalizeOverlay,
	OVERLAY_SCHEMA_VERSION,
	parseCanvasInput,
	parseElementInput,
	parseVariableValueInput,
	type Transform,
	type Variable,
} from "../server/pages/overlays/overlay";
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

type RawOverlay = {
	schemaVersion: number;
	name: string;
	canvas: { width: number; height: number };
	variables: unknown[];
	elements: Record<string, unknown>[];
} & Record<string, unknown>;

const validV1Overlay = (): RawOverlay => ({
	schemaVersion: 1,
	name: "Overlay 1",
	canvas: { width: 1920, height: 1080 },
	variables: [],
	elements: [textElement()],
});

describe("overlay schema", () => {
	test("default overlay is a valid v1 overlay", () => {
		const overlay = defaultOverlay();
		expect(overlay.schemaVersion).toBe(OVERLAY_SCHEMA_VERSION);
		expect(overlay.name).toBe("Overlay 1");
		expect(overlay.canvas).toEqual({ width: 1920, height: 1080 });
		expect(overlay.elements).toHaveLength(0);
		// a fresh overlay must round-trip through the loader
		const loaded = migrateOverlayBlob(clone(overlay));
		expect(loaded.overlay.name).toBe(overlay.name);
	});

	test("migrateOverlayBlob accepts a v1 overlay and preserves unknown fields", () => {
		const raw = validV1Overlay();
		raw.customFlag = "keep-me";
		const el0 = raw.elements[0] as Record<string, unknown>;
		el0.note = "editor draft marker";

		const { overlay, migrated } = migrateOverlayBlob(raw);
		// v1 input now migrates through the v1→v2 step.
		expect(migrated).toBe(true);
		expect(overlay).toHaveProperty("customFlag", "keep-me");
		expect(overlay.elements[0]).toHaveProperty("note", "editor draft marker");
	});

	test("migrateOverlayBlob drops removed viewer_chat elements (v1 → v2)", () => {
		const raw = validV1Overlay();
		raw.elements.push(
			{
				id: "vc-1", name: "chat", type: "viewer_chat",
				transform: { x: 10, y: 10, w: 400, h: 300 },
				visible: true, locked: false, parentId: null, bindings: {}, props: {},
			},
			{
				...textElement(),
				id: "el-2",
				parentId: "vc-1",
			},
		);
		const { overlay } = migrateOverlayBlob(raw);
		const ids = overlay.elements.map((e) => e.id);
		expect(ids).not.toContain("vc-1");
		// a child nested in the removed element is kept, un-parented
		const child = overlay.elements.find((e) => e.id === "el-2");
		expect(child?.parentId).toBeNull();
	});

	test("migrateOverlayBlob rejects unmigratable overlays", () => {
		expect(() => migrateOverlayBlob("nope")).toThrow("not a JSON object");
		expect(() =>
			migrateOverlayBlob({ canvas: { width: 1, height: 1 } }),
		).toThrow("no schemaVersion");
		expect(() =>
			migrateOverlayBlob({ ...validV1Overlay(), schemaVersion: 99 }),
		).toThrow("too old to load it");
	});

	test("normalizeOverlay validates and types variables", () => {
		const raw = validV1Overlay();
		raw.variables = [
			{ id: "v1", name: "score", type: "number", value: "12" },
			{ id: "v2", name: "accent", type: "color", value: "#ABCDEF" },
			{ id: "v3", name: "flag", type: "boolean", value: "yes" },
			{ id: "v4", name: "title", type: "string", value: 7 },
		];
		const overlay = normalizeOverlay(raw);
		expect(overlay.variables[0].value).toBe(12);
		expect(overlay.variables[1].value).toBe("#abcdef");
		expect(overlay.variables[2].value).toBe(true);
		expect(overlay.variables[3].value).toBe("7");
	});

	test("variable normalization rejects bad names and types", () => {
		const raw = validV1Overlay();
		raw.variables = [{ id: "v1", name: "9lives", type: "string", value: "x" }];
		expect(() => normalizeOverlay(raw)).toThrow();
		raw.variables = [{ id: "v1", name: "ok_name", type: "float", value: 1 }];
		expect(() => normalizeOverlay(raw)).toThrow();
	});

	test("normalizeOverlay preserves unknown element props (forward compatibility)", () => {
		const raw = validV1Overlay();
		const el = raw.elements[0] as Record<string, unknown>;
		el.props = {
			text: "Hi",
			fontSize: 42,
			customEffect: "glow",
		};
		const overlay = normalizeOverlay(raw);
		const props = overlay.elements[0].props as Record<string, unknown>;
		expect(props.customEffect).toBe("glow");
		// known text props get defaults where missing
		expect(props.fontSize).toBe(42);
		expect(props.color).toBe(DEFAULT_TEXT_PROPS.color);
	});

	test("elements must be an object and have a valid type", () => {
		expect(() => parseElementInput("x")).toThrow();
		expect(() =>
			parseElementInput({ ...textElement(), type: "banana" }),
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

	test("progress props are normalized with type-specific ranges", () => {
		const el = parseElementInput({
			...textElement(),
			type: "progress",
			props: { value: 150, fill: "#22c55e", background: "#fff", radius: -3 },
		});
		expect(el.type).toBe("progress");
		// out-of-range value/radius fall back to defaults; fill is kept
		expect(el.props.value).toBe(DEFAULT_PROGRESS_PROPS.value);
		expect(el.props.fill).toBe("#22c55e");
		// a 3-hex background is coerced to the default (hex must be #rrggbb)
		expect(el.props.background).toBe(DEFAULT_PROGRESS_PROPS.background);
		expect(el.props.radius).toBe(DEFAULT_PROGRESS_PROPS.radius);
	});

	test("chat element normalizes its channels prop and preserves unknown keys", () => {
		const el = parseElementInput({
			...textElement(),
			type: "chat",
			props: {
				channels: [
					{ platform: "twitch", channel: "Some Streamer" },
					{ platform: "kick", channel: "handle" },
					// dropped: unknown platform; empty channel kept (an in-progress row)
					{ platform: "hulu", channel: "nope" },
					{ platform: "youtube", channel: "   " },
				],
				customEffect: "glow",
			},
		});
		expect(el.type).toBe("chat");
		expect(el.props.channels).toEqual([
			{ platform: "twitch", channel: "some streamer" },
			{ platform: "kick", channel: "handle" },
			{ platform: "youtube", channel: "" },
		]);
		expect(el.props.customEffect).toBe("glow");

		// a missing channels list falls back to []
		const bare = parseElementInput({
			...textElement(),
			type: "chat",
			props: {},
		});
		expect(bare.props.channels).toEqual([]);
	});

	test("chat element normalizes its spacing and fade-out props", () => {
		const el = parseElementInput({
			...textElement(),
			type: "chat",
			props: {
				messageSpacing: 12,
				fadeDirection: "bottom",
				fadeSize: 48,
				textAlign: "justify",
			},
		});
		expect(el.props.messageSpacing).toBe(12);
		expect(el.props.fadeDirection).toBe("bottom");
		expect(el.props.fadeSize).toBe(48);
		expect(el.props.textAlign).toBe("justify");

		// missing props fall back to the defaults (no fade, no spacing)
		const bare = parseElementInput({
			...textElement(),
			type: "chat",
			props: {},
		});
		expect(bare.props.messageSpacing).toBe(DEFAULT_CHAT_PROPS.messageSpacing);
		expect(bare.props.fadeDirection).toBe("off");
		expect(bare.props.fadeSize).toBe(DEFAULT_CHAT_PROPS.fadeSize);
		expect(bare.props.textAlign).toBe("left");

		// out-of-range values, an invalid direction and an invalid alignment
		// fall back to defaults
		const bad = parseElementInput({
			...textElement(),
			type: "chat",
			props: {
				messageSpacing: 999,
				fadeDirection: "side",
				fadeSize: -1,
				textAlign: "oblique",
			},
		});
		expect(bad.props.messageSpacing).toBe(DEFAULT_CHAT_PROPS.messageSpacing);
		expect(bad.props.fadeDirection).toBe("off");
		expect(bad.props.fadeSize).toBe(DEFAULT_CHAT_PROPS.fadeSize);
		expect(bad.props.textAlign).toBe("left");
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

	test("video props are normalized and in-range values kept", () => {
		const el = parseElementInput({
			...textElement(),
			type: "video",
			props: {
				libraryAssetId: "lib-9",
				volume: 0.5,
				muted: false,
				loop: false,
				autoplay: false,
			},
		});
		expect(el.type).toBe("video");
		expect(el.props.libraryAssetId).toBe("lib-9");
		expect(el.props.volume).toBe(0.5);
		expect(el.props.muted).toBe(false);
		expect(el.props.loop).toBe(false);
		expect(el.props.autoplay).toBe(false);
	});

	test("image keeps a libraryAssetId (asset-library file reference)", () => {
		const el = parseElementInput({
			...textElement(),
			type: "image",
			props: { libraryAssetId: "lib-1" },
		});
		expect(el.type).toBe("image");
		expect(el.props.libraryAssetId).toBe("lib-1");

		// a non-string libraryAssetId falls back to ""
		const bad = parseElementInput({
			...textElement(),
			type: "image",
			props: { libraryAssetId: 7 },
		});
		expect(bad.props.libraryAssetId).toBe("");
	});

	test("video props fall back to the defaults when missing or invalid", () => {
		const bare = parseElementInput({
			...textElement(),
			type: "video",
			props: {},
		});
		expect(bare.props.volume).toBe(DEFAULT_VIDEO_PROPS.volume);
		expect(bare.props.muted).toBe(DEFAULT_VIDEO_PROPS.muted);
		expect(bare.props.loop).toBe(DEFAULT_VIDEO_PROPS.loop);
		expect(bare.props.autoplay).toBe(DEFAULT_VIDEO_PROPS.autoplay);

		const bad = parseElementInput({
			...textElement(),
			type: "video",
			props: {
				libraryAssetId: 42,
				volume: 9,
				muted: "no",
				loop: 7,
				autoplay: null,
			},
		});
		expect(bad.props.libraryAssetId).toBe("");
		expect(bad.props.volume).toBe(DEFAULT_VIDEO_PROPS.volume);
		expect(bad.props.muted).toBe(DEFAULT_VIDEO_PROPS.muted);
		expect(bad.props.loop).toBe(DEFAULT_VIDEO_PROPS.loop);
		expect(bad.props.autoplay).toBe(DEFAULT_VIDEO_PROPS.autoplay);
	});

	test("bindings must be variable references and target existing variables", () => {
		const raw = validV1Overlay();
		const el = raw.elements[0] as Record<string, unknown>;
		el.bindings = {
			"props.text": { kind: "variable", variableId: "v1" },
		};
		expect(() => normalizeOverlay(raw)).toThrow(
			"binding to unknown variable v1",
		);
		raw.variables = [{ id: "v1", name: "title", type: "string", value: "hi" }];
		const ok = normalizeOverlay(raw);
		expect(ok.elements[0].bindings["props.text"]).toEqual({
			kind: "variable",
			variableId: "v1",
		});

		// non-variable binding kinds are rejected in v1
		el.bindings = {
			"props.text": { kind: "expr", expression: "1+1" },
		};
		expect(() => normalizeOverlay(raw)).toThrow();
	});

	test("bindings may target any attribute path (props.*, transform.*, visible)", () => {
		const raw = validV1Overlay();
		raw.variables = [{ id: "v1", name: "x", type: "string", value: "0" }];
		const el = raw.elements[0] as Record<string, unknown>;
		el.bindings = {
			"props.title": { kind: "variable", variableId: "v1" },
			"transform.x": { kind: "variable", variableId: "v1" },
			"transform.opacity": { kind: "variable", variableId: "v1" },
			visible: { kind: "variable", variableId: "v1" },
		};
		const ok = normalizeOverlay(raw);
		expect(ok.elements[0].bindings).toEqual({
			"props.title": { kind: "variable", variableId: "v1" },
			"transform.x": { kind: "variable", variableId: "v1" },
			"transform.opacity": { kind: "variable", variableId: "v1" },
			visible: { kind: "variable", variableId: "v1" },
		});
	});

	test("legacy embedded assets are dropped on load", () => {
		const raw: RawOverlay = {
			...validV1Overlay(),
			assets: [
				{
					id: "a1",
					hash: "ab",
					mime: "image/png",
					filename: "x.png",
					dataBase64: "AAAA",
				},
			],
		};
		const ok = normalizeOverlay(raw);
		expect("assets" in ok).toBe(false);
	});

	test("isMimeKind classifies media mimes", () => {
		expect(isMimeKind("video/mp4", "video")).toBe(true);
		expect(isMimeKind("audio/mpeg", "audio")).toBe(true);
		expect(isMimeKind("image/png", "video")).toBe(false);
	});

	test("parent elements must exist, be groups, and be acyclic", () => {
		const base = () => {
			const raw = validV1Overlay();
			raw.variables = [];
			return raw;
		};

		// missing parent
		{
			const raw = base();
			raw.elements = [{ ...textElement(), parentId: "ghost" }];
			expect(() => normalizeOverlay(raw)).toThrow("missing parent");
		}

		// non-group parent
		{
			const raw = base();
			raw.elements = [
				textElement(),
				{ ...textElement({ id: "el-2", parentId: "el-1" }) },
			];
			expect(() => normalizeOverlay(raw)).toThrow("non-group parent");
		}

		// cycle
		{
			const raw = base();
			raw.elements = [
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
			expect(() => normalizeOverlay(raw)).toThrow();
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
		const raw = validV1Overlay();
		raw.canvas = { width: 9999, height: 1080 };
		expect(() => normalizeOverlay(raw)).toThrow("canvas");
		raw.canvas = { width: 8192, height: 16 };
		expect(normalizeOverlay(raw).canvas).toEqual({ width: 8192, height: 16 });
	});

	test("normalizeFilters clamps values to each type's range", () => {
		expect(
			normalizeFilters([
				{ type: "blur", value: 500 },
				{ type: "grayscale", value: -10 },
				{ type: "hue-rotate", value: 45 },
			]),
		).toEqual([
			{ type: "blur", value: 100 },
			{ type: "grayscale", value: 0 },
			{ type: "hue-rotate", value: 45 },
		]);
	});

	test("normalizeFilters drops unknown types and non-finite values", () => {
		expect(
			normalizeFilters([
				{ type: "foo", value: 5 },
				{ type: "sepia", value: 30 },
			]),
		).toEqual([{ type: "sepia", value: 30 }]);
		expect(
			normalizeFilters([
				{ type: "blur", value: "x" },
				{ type: "invert", value: 20 },
			]),
		).toEqual([{ type: "invert", value: 20 }]);
		expect(normalizeFilters([null, 5, { type: "blur" }])).toEqual([]);
	});

	test("normalizeFilters treats non-array input as empty", () => {
		expect(normalizeFilters(undefined)).toEqual([]);
		expect(normalizeFilters("blur(2px)")).toEqual([]);
		expect(normalizeFilters({ type: "blur", value: 4 })).toEqual([]);
		expect(normalizeFilters(null)).toEqual([]);
	});

	test("cssFilterString renders the CSS filter value", () => {
		expect(
			cssFilterString([
				{ type: "blur", value: 4 },
				{ type: "grayscale", value: 40 },
			]),
		).toBe("blur(4px) grayscale(40%)");
		expect(cssFilterString([{ type: "hue-rotate", value: 90 }])).toBe(
			"hue-rotate(90deg)",
		);
		expect(cssFilterString([])).toBe("");
		expect(cssFilterString(undefined)).toBe("");
		// it normalizes its input, so out-of-range values clamp in the output
		expect(cssFilterString([{ type: "blur", value: 500 }])).toBe("blur(100px)");
	});

	test("an element's props.filters is normalized across every element type", () => {
		const el = parseElementInput(
			textElement({
				props: {
					text: "Hi",
					filters: [
						{ type: "blur", value: 55 },
						{ type: "brightness", value: 9999 },
						{ type: "nope", value: 3 },
					],
				},
			}),
		);
		expect(el.props.filters).toEqual([
			{ type: "blur", value: 55 },
			{ type: "brightness", value: 400 },
		]);
		// a type with no filters prop normalizes to an empty list, not a hole
		const rect = parseElementInput({
			...textElement(),
			type: "rectangle",
			id: "el-r",
			props: { fill: "#3b82f6" },
		});
		expect(rect.props.filters).toEqual([]);
	});
});
