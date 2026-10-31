/*
 * Overlay element contract + shared (non-element-specific) helpers.
 *
 * Every concrete element lives in its own module (text.tsx, image.tsx,
 * rectangle.tsx, …), implements `OverlayElementDef` and is registered in
 * registry.ts. Core files (overlay-render.tsx, overlays.tsx, overlay.tsx)
 * only talk to the registry — they contain no element-specific code.
 */
import m from "mithril";
import type {
	Asset,
	OverlayElement,
	OverlayElementType,
	Variable,
	VariableValue,
} from "../../../shared/overlay";
import type { Children } from "mithril";
import { t } from "../i18n";
export type { OverlayElement, OverlayElementType } from "../../../shared/overlay";

// ── render context ──────────────────────────────────────────────────────

export interface ElementContext {
	/** asset id -> data: URL */
	assetUrls: Map<string, string>;
	/** variable id -> current value (for binding resolution) */
	variables: Map<string, VariableValue>;
}

/** A CSS style object (a subset of mithril's CSSObject). */
export type CSS = Record<string, string | number | undefined>;

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

/** Positioning + shared visual style for any element.
 * NOTE: carries EVERYTHING the visual depends on inline (position, size,
 * rotation PIVOT, whitespace) — the page stylesheets (overlay.css for the
 * runtime, style.css for the editor) are NOT required to provide it. Both
 * pages must stay pixel-identical, so never move these back to CSS. */
export function elementStyle(element: OverlayElement): CSS {
	const t = element.transform;
	return {
		position: "absolute",
		left: `${t.x}px`,
		top: `${t.y}px`,
		width: `${t.width}px`,
		height: `${t.height}px`,
		transform: `rotate(${t.rotation}deg)`,
		transformOrigin: "50% 50%",
		whiteSpace: "pre",
		opacity: `${t.opacity}`,
		visibility: element.visible ? "visible" : "hidden",
		boxSizing: "border-box",
	};
}

// ── prop access helpers (defensive reads of the resolved props record) ──

export function strProp(
	p: Record<string, unknown>,
	key: string,
	fallback: string,
): string {
	const v = p[key];
	return typeof v === "string" ? v : fallback;
}

export function numProp(
	p: Record<string, unknown>,
	key: string,
	fallback: number,
): number {
	const v = p[key];
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Embedded-page render shared by the iframe and chat elements: a dashed
 * placeholder box when there is no URL, otherwise an `<iframe>`.
 * Styles are fully inline so editor and runtime stay pixel-identical.
 * `pointerEvents: "none"` lets the editor's mouse fall through to the
 * `.overlay-element` wrapper (drag/select); embedded pages are display-only.
 * No `sandbox` — the page runs its own scripts and authenticated fetches. */
export function drawIframe(
	element: OverlayElement,
	ctx: ElementContext,
): Children {
	const url = strProp(
		resolveElementProps(element, ctx.variables),
		"url",
		"",
	);
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
			t("overlay.missing_url"),
		);
	return m("iframe.overlay-iframe", {
		src: url,
		title: element.name,
		style: {
			width: "100%",
			height: "100%",
			border: "none",
			display: "block",
			background: "transparent",
			pointerEvents: "none",
		},
	} as Record<string, unknown>);
}

// ── the element contract ────────────────────────────────────────────────

/** A chat module (a dashboard widget of type "chat") that the chat
 * element's inspector can offer as a one-click target. The overlay URL is
 * built from dashboardId + widgetId + token — no cookies, so OBS can render
 * it in an external browser source. */
export interface ChatWidgetRef {
	dashboardId: string;
	widgetId: string;
	/** Dashboard name (label grouping) — display only. */
	dashboardName: string;
	/** Widget name — the label shown in the picker. */
	name: string;
	/** Per-widget auth token; required to load the live chat page. */
	token: string;
}

/** What the inspector's per-element edit form receives.
 * `mutate` runs a mutation on the row's element (the core persists it and
 * takes an undo snapshot); `assets`/`variables` back the binding selects;
 * `upload` is the project's asset uploader (used by the image element);
 * `chatWidgets` backs the chat element's module picker. */
export interface ElementProps {
	element: OverlayElement;
	mutate: (fn: (e: OverlayElement) => void) => void;
	assets: Asset[];
	variables: Variable[];
	/** Upload a file as a new project asset; resolves to its id (or null). */
	upload: (file: File) => Promise<string | null>;
	/** The user's chat modules, for the iframe element's picker. */
	chatWidgets: ChatWidgetRef[];
}

/** Which editing affordance an element shows when selected on the canvas.
 * A line is `endpoints` (2 handles) and can therefore never present the
 * rectangle's box editing — the mode is structural, not a prop check. */
export type HandleMode = "box" | "endpoints" | "none";

/** The contract every overlay element fulfils:
 *   - `defaultProps` / `defaultSize`: what a freshly created element looks like
 *   - `draw`:        renders the element (content only; core wraps + positions)
 *   - `editForm`:    publishes the element's inspector form
 *   - `validate`:    returns problems with the element (empty = editable)
 *   - `handles`:     drives the canvas selection handles (box / endpoints / none) */
export interface OverlayElementDef {
	readonly type: OverlayElementType;
	readonly defaultProps: Record<string, unknown>;
	readonly defaultSize: { width: number; height: number };
	draw(element: OverlayElement, ctx: ElementContext): Children;
	editForm(props: ElementProps): Children;
	validate(element: OverlayElement): string[];
	readonly handles: HandleMode;
}
