/*
 * Overlay element contract (browser half) + shared, non-element-specific
 * render helpers.
 *
 * A module contributes elements by default-exporting `OverlayElementDef[]`
 * from `<module>/overlay_elements.tsx`; scripts/gen_modules.ts collects them
 * into generated/overlay_elements.ts and ./registry.ts indexes them. The
 * editor and the runtime page only talk to the registry — they contain no
 * element-specific code. The environment-free half (type, default props,
 * validation) is the `OverlayElementSchema` in
 * shared/contracts/overlay_element.ts, contributed from
 * `<module>/overlay_schema.ts`.
 */
import m from "mithril";
import type {
	Asset,
	OverlayElement,
	OverlayElementType,
	Transform,
	Variable,
	VariableValue,
} from "../../overlay";
import type { Children, Vnode } from "mithril";
import { t } from "../i18n";
export type { OverlayElement, OverlayElementType } from "../../overlay";

/** Runtime trigger state of one active trigger-driven element (alerts).
 * The payload is the last trigger that fired the element — template tokens
 * fall back to its keys. */
export interface TriggerState {
	startedAt: number;
	expiresAt: number;
	payload: Record<string, unknown>;
}

/** Intro window of a trigger-driven element: the first moments after a
 * trigger, during which the element's intro animation plays. */
export const TRIGGER_INTRO_MS = 400;
/** Outro window: the final moments before expiry, during which the element's
 * outro animation plays. The runtime page redraws at the window's start. */
export const TRIGGER_OUTRO_MS = 400;

/** The visual phase of a trigger-driven element at a point in time:
 * `design` = not triggered (editor), then `in` (intro window), `show`
 * (main display), `out` (outro window before removal). */
export type TriggerPhase = "design" | "in" | "show" | "out";

export function triggerPhase(
	active: TriggerState | undefined,
	now: number,
): TriggerPhase {
	if (!active) return "design";
	if (now - active.startedAt < TRIGGER_INTRO_MS) return "in";
	if (now >= active.expiresAt) return "design";
	if (active.expiresAt - now < TRIGGER_OUTRO_MS) return "out";
	return "show";
}

export interface ElementContext {
	/** asset id -> data: URL */
	assetUrls: Map<string, string>;
	/** variable id -> current value (for binding resolution) */
	variables: Map<string, VariableValue>;
	/** variable NAME -> current value (for `{token}` template resolution) */
	variableNames: Map<string, VariableValue>;
	/** element id -> live trigger state. Present on the runtime page only;
	 * the editor has none, so trigger-driven elements always render their
	 * design state there. Absent/missing = the element is not active. */
	activeTriggers?: Map<string, TriggerState>;
	/** The overlay token that authenticates token-scoped feeds (a self-
	 * contained chat element). The editor uses its overlay's token; the
	 * runtime page the one its URL carries. Absent = not live. */
	token?: string;
	/** The id of the overlay being rendered. The runtime page's overlay is
	 * fixed; the editor's is its selected overlay. */
	overlayId?: string;
}

/** A CSS style object (a subset of mithril's CSSObject). */
export type CSS = Record<string, string | number | undefined>;

export function assetUrl(asset: Asset): string {
	return `data:${asset.mime};base64,${asset.dataBase64}`;
}

export interface ResolvedElement {
	props: Record<string, unknown>;
	transform: Transform;
	visible: boolean;
}

/**
 * Coerce a variable value to the number a `transform.*` binding carries.
 * Rejects non-finite values and out-of-range opacity so a bad variable can't
 * break the layout; returns `undefined` to skip the assignment.
 */
function bindTransformValue(raw: VariableValue, key: string): number | undefined {
	const n = Number(raw);
	if (!Number.isFinite(n)) return undefined;
	if (key === "transform.opacity" && (n < 0 || n > 1)) return undefined;
	return n;
}

/**
 * Resolve every element attribute against the current variable values.
 * Binding keys target any attribute: `props.<key>` replaces a prop,
 * `transform.<field>` replaces one of x/y/width/height/rotation/opacity
 * (number-coerced, must be finite), and `visible` replaces visibility.
 * Unknown paths are ignored defensively. The renderer and editor resolve
 * once per element and treat the result as the display state.
 */
export function resolveElement(
	element: OverlayElement,
	variables: Map<string, VariableValue>,
): ResolvedElement {
	const props: Record<string, unknown> = { ...element.props };
	const transform: Transform = { ...element.transform };
	let visible = element.visible;

	for (const [key, binding] of Object.entries(element.bindings)) {
		if (binding.kind !== "variable") continue;
		const value = variables.get(binding.variableId);
		if (value === undefined) continue;

		if (key === "visible") {
			visible = Boolean(value);
		} else if (key.startsWith("transform.")) {
			const field = key.slice("transform.".length);
			const n = bindTransformValue(value, key);
			if (field && n !== undefined) {
				transform[field as keyof Transform] = n;
			}
		} else if (key.startsWith("props.")) {
			const field = key.slice("props.".length);
			if (field) props[field] = value;
		}
	}
	return { props, transform, visible };
}

/** Merge variable bindings over the element's props. Kept for callers/tests
 * that only need the prop half of `resolveElement`. */
export function resolveElementProps(
	element: OverlayElement,
	variables: Map<string, VariableValue>,
): Record<string, unknown> {
	return resolveElement(element, variables).props;
}

/** Positioning + shared visual style for any element.
 * Pass the *resolved* element (output of `resolveElement`) so bound
 * transform/opacity/visible render identically in the editor and OBS.
 * NOTE: carries EVERYTHING the visual depends on inline (position, size,
 * rotation PIVOT, whitespace) — the page stylesheets (overlay.css for the
 * runtime, style.css for the editor) are NOT required to provide it. Both
 * pages must stay pixel-identical, so never move these back to CSS. */
export function elementStyle(
	element: { transform: Transform; visible: boolean },
): CSS {
	const t = element.transform;
	// Rotated elements get `rotate(deg)` with the origin pinned to the
	// element center. Unrotated elements must NOT carry a `transform` at
	// all: Chromium (and CEF, used by OBS) promotes any transformed
	// ancestor of an `<iframe>` to a composited layer and paints that
	// layer opaque white — so even an identity `rotate(0deg)` turned
	// iframe/chat elements into solid white boxes. Omitting `transform`
	// keeps them transparent. See overlay_render.tsx + overlay.css note.
	return {
		position: "absolute",
		left: `${t.x}px`,
		top: `${t.y}px`,
		width: `${t.width}px`,
		height: `${t.height}px`,
		// Explicit: keep the wrapper transparent — on Chromium/CEF a
		// transformed ancestor promotes iframe descendants to a composited
		// layer that can otherwise paint an opaque white backing.
		background: "transparent",
		...(t.rotation
			? {
					transform: `rotate(${t.rotation}deg)`,
					transformOrigin: "50% 50%",
				}
			: {}),
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
export function drawIframe(element: OverlayElement): Children {
	// `element` is the resolved element from the renderer, so props are final.
	const url = strProp(element.props, "url", "");
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

/** What the inspector's per-element edit form receives.
 * `mutate` runs a mutation on the row's element (the core persists it and
 * takes an undo snapshot); `assets`/`variables` back the binding selects;
 * `upload` is the project's asset uploader (used by the image element).
 * An element that needs more (e.g. a list fetched from the server) loads it
 * itself inside its form. */
export interface ElementProps {
	element: OverlayElement;
	mutate: (fn: (e: OverlayElement) => void) => void;
	assets: Asset[];
	variables: Variable[];
	/** Upload a file as a new project asset; resolves to its id (or null). */
	upload: (file: File) => Promise<string | null>;
}

/** Which editing affordance an element shows when selected on the canvas.
 * A line is `endpoints` (2 handles) and can therefore never present the
 * rectangle's box editing — the mode is structural, not a prop check. */
export type HandleMode = "box" | "endpoints" | "none";

/** The contract every overlay element fulfils:
 *   - `labelKey` / `icon` / `order`: its entry in the editor's "add" toolbar
 *     (no toolbar entry when `labelKey` is omitted, e.g. a structural type)
 *   - `defaultProps` / `defaultSize`: what a freshly created element looks like
 *   - `draw`:        renders the element (content only; core wraps + positions)
 *   - `editForm`:    publishes the element's inspector form
 *   - `validate`:    returns problems with the element (empty = editable)
 *   - `handles`:     drives the canvas selection handles (box / endpoints / none) */
export interface OverlayElementDef {
	readonly type: OverlayElementType;
	/** i18n key of the "add <element>" action; omit to keep the type out of the toolbar. */
	readonly labelKey?: string;
	/** Toolbar icon (a vnode factory, so the module brings its own pictogram). */
	readonly icon?: () => Vnode;
	/** Toolbar position; lower first (defaults to 100). */
	readonly order?: number;
	readonly defaultProps: Record<string, unknown>;
	/** Prop names that exist on the type; the inspector offers a binding
	 * toggle on each field the `editForm` wraps in `bindField` — bound as
	 * `props.<key>`, e.g. text → "props.text". */
	readonly propKeys: readonly string[];
	readonly defaultSize: { width: number; height: number };
	/** Renders the element's contents. `element` is the RESOLVED element —
	 * its props/transform/visible already carry any binding values. Content
	 * only; core wraps + positions it via elementStyle(). */
	draw(element: OverlayElement, ctx: ElementContext): Children;
	editForm(props: ElementProps): Children;
	validate(element: OverlayElement): string[];
	readonly handles: HandleMode;
	/** For `handles: "endpoints"`: the editor reports the drag delta (box
	 * frame, from the fixed endpoint) so the element can record which
	 * diagonal it runs along. */
	onEndpointDrag?(element: OverlayElement, dx: number, dy: number): void;
	/** Offer in-place editing of one string prop on the canvas (double-click):
	 * the editor overlays a textarea styled by `style(resolvedProps)` so the
	 * edit is what-you-see. */
	readonly inlineEdit?: {
		prop: string;
		style(props: Record<string, unknown>): Record<string, string>;
	};
	/** Present = the element is trigger-driven: it renders only while a
	 * runtime trigger has it active (the editor always renders its design
	 * state). The runtime page calls this for every alert event
	 * (`GET /overlay/alert/<name>` → `overlays.alert` frame) at the
	 * moment the alert goes on air — immediately when the element is
	 * free, at the previous claim's expiry when it is queued; it returns
	 * the display duration in ms when this instance fires on the event
	 * (evaluating any variation/condition props), `undefined` when the
	 * event doesn't claim it (a queued claim that fails its condition
	 * is dropped and the queue continues). The trigger's
	 * `<name>=<value>` pairs ride in `payload` and are already written
	 * into the project variables (and `ctx`) by the runtime page before
	 * this runs — a queued alert's values only land at its play time, so
	 * they never clobber the on-air ones early; the written values
	 * persist (the runtime page sends them over the `overlays.applyAlert`
	 * uplink) and are never emptied. Side effects (audio, TTS) belong in
	 * here so they play when the alert goes on air, not when the trigger
	 * arrives. `ctx` carries the live asset URLs and variable values. */
	onTrigger?(
		element: OverlayElement,
		eventName: string,
		payload: Record<string, unknown>,
		ctx: ElementContext,
	): number | undefined;
}
