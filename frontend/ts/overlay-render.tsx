/** @jsx m */
/*
 * Shared overlay element renderer. Used by BOTH the editor preview and the
 * OBS runtime page so positions are pixel-identical: one function, one style
 * model (absolute scene coordinates, CSS px at 1:1 when unscaled).
 */
import m from "mithril";
import type {
	Asset,
	OverlayElement,
	VariableValue,
} from "../../shared/overlay";

/** A CSS style object (a subset of mithril's CSSObject). */
type CSS = Record<string, string | number | undefined>;

export interface ElementContext {
	/** asset id -> data: URL */
	assetUrls: Map<string, string>;
	/** variable id -> current value (for binding resolution) */
	variables: Map<string, VariableValue>;
}

export function assetUrl(asset: Asset): string {
	return `data:${asset.mime};base64,${asset.dataBase64}`;
}

function bindTarget(bindingKey: string): string | null {
	// bindings are keyed "props.<name>" in v1
	if (bindingKey.startsWith("props.")) return bindingKey.slice("props.".length);
	return null;
}

/** Merge variable bindings over the element's props (v1: variable refs). */
export function resolveElementProps(
	element: OverlayElement,
	variables: Map<string, VariableValue>,
): Record<string, unknown> {
	const props: Record<string, unknown> = { ...element.props };
	for (const [key, binding] of Object.entries(element.bindings)) {
		if (binding.kind !== "variable") continue;
		const value = variables.get(binding.variableId);
		if (value === undefined) continue;
		const target = bindTarget(key);
		if (target) props[target] = value;
	}
	return props;
}

interface TextProps {
	text: string;
	fontSize: number;
	fontFamily: string;
	color: string;
	fontWeight: number;
	lineHeight: number;
	textAlign: "left" | "center" | "right";
}

interface ShapeProps {
	shape: "rect" | "ellipse" | "line";
	fill: string;
	stroke: string;
	strokeWidth: number;
}

function textProps(raw: Record<string, unknown>): TextProps {
	const num = (v: unknown, d: number) =>
		typeof v === "number" && Number.isFinite(v) ? v : d;
	const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
	const align = raw.textAlign;
	return {
		text: str(raw.text, ""),
		fontSize: num(raw.fontSize, 48),
		fontFamily: str(raw.fontFamily, "Inter, system-ui, sans-serif"),
		color: str(raw.color, "#ffffff"),
		fontWeight: num(raw.fontWeight, 600),
		lineHeight: num(raw.lineHeight, 1.2),
		textAlign: align === "center" || align === "right" ? align : "left",
	};
}

function shapeProps(raw: Record<string, unknown>): ShapeProps {
	const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
	const num = (v: unknown, d: number) =>
		typeof v === "number" && Number.isFinite(v) ? v : d;
	const shape = raw.shape;
	return {
		shape: shape === "ellipse" || shape === "line" ? shape : "rect",
		fill: str(raw.fill, "#0ea5e9"),
		stroke: str(raw.stroke, "transparent"),
		strokeWidth: num(raw.strokeWidth, 0),
	};
}

/** Positioning + shared visual style for any element. */
export function elementStyle(element: OverlayElement): CSS {
	const t = element.transform;
	return {
		position: "absolute",
		left: `${t.x}px`,
		top: `${t.y}px`,
		width: `${t.width}px`,
		height: `${t.height}px`,
		transform: `rotate(${t.rotation}deg)`,
		opacity: `${t.opacity}`,
		visibility: element.visible ? "visible" : "hidden",
		boxSizing: "border-box",
	};
}

function TextView(
	element: OverlayElement,
	props: TextProps,
): ReturnType<typeof m> {
	return m(
		".overlay-text",
		{
			style: {
				fontFamily: props.fontFamily,
				fontSize: `${props.fontSize}px`,
				color: props.color,
				fontWeight: `${props.fontWeight}`,
				lineHeight: `${props.lineHeight}`,
				justifyContent:
					props.textAlign === "left"
						? "flex-start"
						: props.textAlign === "center"
							? "center"
							: "flex-end",
			},
		},
		props.text ?? "",
	);
}

function ShapeView(
	element: OverlayElement,
	props: ShapeProps,
): ReturnType<typeof m> {
	const t = element.transform;
	if (props.shape === "line") {
		// draw a line through the box, oriented along its w/h delta
		const length = Math.hypot(t.width, t.height);
		const angle = (Math.atan2(t.height, t.width) * 180) / Math.PI;
		return m(".overlay-shape", {
			style: {
				width: `${Math.max(1, length)}px`,
				height: `${Math.max(1, props.strokeWidth || 4)}px`,
				background: props.fill,
				transform: `rotate(${angle}deg)`,
				left: "50%",
				top: "50%",
				margin: `${-(Math.max(1, props.strokeWidth || 4) / 2).toFixed(
					1,
				)}px ${-(Math.max(1, length) / 2).toFixed(1)}px 0 0`,
				position: "absolute",
			},
		});
	}
	return m(".overlay-shape", {
		style: {
			background: props.fill,
			border:
				props.strokeWidth > 0
					? `${props.strokeWidth}px solid ${props.stroke}`
					: undefined,
			borderRadius: props.shape === "ellipse" ? "50%" : "0",
		},
	});
}

function ImageView(
	element: OverlayElement,
	ctx: ElementContext,
): ReturnType<typeof m> {
	const assetId = element.props.assetId;
	const url =
		typeof assetId === "string" ? ctx.assetUrls.get(assetId) : undefined;
	if (!url)
		return m(
			".overlay-shape",
			{
				style: {
					border: "1px dashed rgba(255,255,255,0.4)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					color: "rgba(255,255,255,0.5)",
					fontSize: "14px",
				},
			},
			"missing image",
		);
	return m("img.overlay-image", {
		src: url,
		alt: element.name,
		draggable: false,
	});
}

/** Render one element (content + positioning) for editor and runtime. */
export function overlayElementView(
	element: OverlayElement,
	ctx: ElementContext,
): ReturnType<typeof m> {
	const props = resolveElementProps(element, ctx.variables);
	let content: m.Children;
	switch (element.type) {
		case "text":
			content = TextView(element, textProps(props));
			break;
		case "shape":
			content = ShapeView(element, shapeProps(props));
			break;
		case "image":
			content = ImageView(element, ctx);
			break;
		default:
			content = null; // groups render as containers only
	}
	return m(
		".overlay-element",
		{
			key: element.id,
			"data-element": element.id,
			style: elementStyle(element),
		},
		content,
	);
}

/** All elements of a scene, back to front. Groups render after (above) so
 * their children — drawn in absolute canvas space — stay selectable. */
export function sceneElementsView(
	elements: OverlayElement[],
	ctx: ElementContext,
): Array<ReturnType<typeof m>> {
	const groups = new Set(
		elements.filter((e) => e.type === "group").map((e) => e.id),
	);
	return elements
		.filter((e) => !groups.has(e.id))
		.map((el) => overlayElementView(el, ctx));
}
