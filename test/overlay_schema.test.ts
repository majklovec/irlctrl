import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_PROPS } from "../server/modules/chat/overlay_schema";
import {
	DEFAULT_LINE_PROPS,
	DEFAULT_PROGRESS_PROPS,
	DEFAULT_RECTANGLE_PROPS,
	DEFAULT_TEXT_PROPS,
	DEFAULT_VIDEO_PROPS,
} from "../server/modules/overlay_elements/overlay_schema";
import {
	cssFilterString,
	defaultProject,
	generateOverlayToken,
	isAcceptedAssetMime,
	isMimeKind,
	migrateProjectBlob,
	normalizeFilters,
	normalizeProject,
	OVERLAY_SCHEMA_VERSION,
	overlayTokenMatches,
	parseCanvasInput,
	parseElementInput,
	parseSceneInput,
	parseVariableValueInput,
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
		// the scene's UUID id is its only identifier
		expect(project.scenes[0].id).toMatch(/^[0-9a-f-]{36}$/);
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

	test("normalizeProject enforces unique scene ids", () => {
		const raw = validV1Project();
		raw.scenes = [
			{ id: "a", name: "A", elements: [] },
			{ id: "a", name: "B", elements: [] },
		];
		expect(() => normalizeProject(raw)).toThrow("duplicate scene id a");
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
				assetId: "asset-2",
				volume: 0.5,
				muted: false,
				loop: false,
				autoplay: false,
			},
		});
		expect(el.type).toBe("video");
		expect(el.props.assetId).toBe("asset-2");
		expect(el.props.volume).toBe(0.5);
		expect(el.props.muted).toBe(false);
		expect(el.props.loop).toBe(false);
		expect(el.props.autoplay).toBe(false);
	});

	test("video props fall back to the defaults when missing or invalid", () => {
		const bare = parseElementInput({
			...textElement(),
			type: "video",
			props: { assetId: "" },
		});
		expect(bare.props.volume).toBe(DEFAULT_VIDEO_PROPS.volume);
		expect(bare.props.muted).toBe(DEFAULT_VIDEO_PROPS.muted);
		expect(bare.props.loop).toBe(DEFAULT_VIDEO_PROPS.loop);
		expect(bare.props.autoplay).toBe(DEFAULT_VIDEO_PROPS.autoplay);

		const bad = parseElementInput({
			...textElement(),
			type: "video",
			props: {
				assetId: 42,
				volume: 9,
				muted: "no",
				loop: 7,
				autoplay: null,
			},
		});
		expect(bad.props.assetId).toBe("");
		expect(bad.props.volume).toBe(DEFAULT_VIDEO_PROPS.volume);
		expect(bad.props.muted).toBe(DEFAULT_VIDEO_PROPS.muted);
		expect(bad.props.loop).toBe(DEFAULT_VIDEO_PROPS.loop);
		expect(bad.props.autoplay).toBe(DEFAULT_VIDEO_PROPS.autoplay);
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

	test("bindings may target any attribute path (props.*, transform.*, visible)", () => {
		const raw = validV1Project();
		raw.variables = [{ id: "v1", name: "x", type: "string", value: "0" }];
		const el = (raw.scenes[0] as { elements: Record<string, unknown>[] })
			.elements[0] as Record<string, unknown>;
		(el as Record<string, unknown>).bindings = {
			"props.title": { kind: "variable", variableId: "v1" },
			"transform.x": { kind: "variable", variableId: "v1" },
			"transform.opacity": { kind: "variable", variableId: "v1" },
			visible: { kind: "variable", variableId: "v1" },
		};
		const ok = normalizeProject(raw);
		expect(ok.scenes[0].elements[0].bindings).toEqual({
			"props.title": { kind: "variable", variableId: "v1" },
			"transform.x": { kind: "variable", variableId: "v1" },
			"transform.opacity": { kind: "variable", variableId: "v1" },
			visible: { kind: "variable", variableId: "v1" },
		});
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

	test("image, video and audio asset mimes are accepted", () => {
		for (const mime of [
			"image/png",
			"video/mp4",
			"audio/mpeg",
			"audio/wav",
			"video/webm",
		] as const) {
			expect(isAcceptedAssetMime(mime)).toBe(true);
		}
		for (const mime of ["text/html", "application/json", "pdf", ""] as const) {
			expect(isAcceptedAssetMime(mime)).toBe(false);
		}
		expect(isMimeKind("video/mp4", "video")).toBe(true);
		expect(isMimeKind("audio/mpeg", "audio")).toBe(true);
		expect(isMimeKind("image/png", "video")).toBe(false);
	});

	test("normalization keeps video/audio mimes, rejects others", () => {
		const raw = validV1Project();
		raw.assets = [
			{
				id: "vid",
				hash: "ab",
				mime: "video/mp4",
				filename: "x.mp4",
				dataBase64: "AAAA",
			},
			{
				id: "snd",
				hash: "cd",
				mime: "audio/mpeg",
				filename: "x.mp3",
				dataBase64: "AAAA",
			},
		];
		const assets = normalizeProject(raw).assets;
		expect(assets.find((a) => a.id === "vid")?.mime).toBe("video/mp4");
		expect(assets.find((a) => a.id === "snd")?.mime).toBe("audio/mpeg");

		raw.assets.push({
			id: "bad",
			hash: "ef",
			mime: "application/x-msdownload",
			filename: "x.exe",
			dataBase64: "AAAA",
		});
		expect(() => normalizeProject(raw)).toThrow("mime");
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
		expect(() => parseSceneInput({})).toThrow("name or elements");
		expect(parseSceneInput({ name: "New" })).toEqual({ name: "New" });
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
