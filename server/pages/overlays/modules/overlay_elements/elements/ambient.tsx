/** @jsx m */
/*
 * The ambient background element: an animated canvas background. The set of
 * backgrounds is open-ended — see `ambient_backgrounds/` (one class per
 * background over a shared engine); this file only wires the element
 * contract around the `AMBIENT_VARIANTS` catalog.
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { numProp, strProp } from "@ui/overlay/element";
import { bindableForm } from "@ui/overlay/fields";
import type { Vnode, VnodeDOM } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import {
	AMBIENT_VARIANT_IDS,
	AMBIENT_VARIANTS,
	type AmbientVariant,
	ambientVariant,
} from "./ambient_backgrounds";
import {
	type AmbientEnv,
	type AmbientOptions,
	createAmbientEnv,
} from "./ambient_backgrounds/engine";

export interface AmbientProps {
	/** which background runs (id from the ambient/ catalog) */
	kind: string;
	/** animation tempo, 0.1–4× the background's base speed */
	speed: number;
	/** 1–10 trail multiplier — higher fades each frame less, longer trails */
	trail: number;
	/** solid colour painted under the animation */
	background: string;
}

export const DEFAULT_AMBIENT_PROPS: Required<AmbientProps> = {
	kind: "aurora",
	speed: 1,
	trail: 1,
	background: "#05070d",
};

/** A Mithril canvas vnode carrying the running animation's stop function. */
interface AmbientVnode extends VnodeDOM {
	state: {
		key: string;
		stop: (() => void) | undefined;
	};
}

/** Restart the animation when the element's box or its visual props change.
 * The key compares everything the animation depends on; a hit means the
 * running instance is already current. */
function startAnimation(
	vnode: AmbientVnode,
	kind: string,
	width: number,
	height: number,
	opts: AmbientOptions,
): void {
	const key = [
		kind,
		width,
		height,
		opts.speed,
		opts.trail,
		opts.background,
		// Restart when a background's own props change (stable key order).
		...Object.keys(opts.custom)
			.sort()
			.map((k) => `${k}:${opts.custom[k]}`),
	].join("|");
	if (vnode.state.key === key) return;
	const def: AmbientVariant | undefined = ambientVariant(kind);
	if (!def) return;
	vnode.state.stop?.();
	const env: AmbientEnv = createAmbientEnv(
		vnode.dom as HTMLCanvasElement,
		width,
		height,
	);
	vnode.state.key = key;
	vnode.state.stop = def.start(env, opts);
}

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const kind = strProp(element.props, "kind", DEFAULT_AMBIENT_PROPS.kind);
	if (!ambientVariant(kind)) return m(".overlay-shape");
	// The selected background's own props, resolved over its registered
	// defaults (backgrounds without custom ones get an empty record).
	const customDefaults = ambientVariant(kind)?.customDefaults ?? {};
	const custom: Record<string, number> = {};
	for (const k of Object.keys(customDefaults))
		custom[k] = numProp(element.props, k, customDefaults[k]);
	const opts: AmbientOptions = {
		speed: numProp(element.props, "speed", DEFAULT_AMBIENT_PROPS.speed),
		trail: numProp(element.props, "trail", DEFAULT_AMBIENT_PROPS.trail),
		background: strProp(
			element.props,
			"background",
			DEFAULT_AMBIENT_PROPS.background,
		),
		custom,
	};
	const { width, height } = element.transform;
	const restart = (vnode: VnodeDOM): void =>
		startAnimation(vnode as AmbientVnode, kind, width, height, opts);
	return m("canvas.overlay-ambient", {
		style: {
			display: "block",
			width: "100%",
			height: "100%",
			background: opts.background,
		},
		oncreate: restart,
		onupdate: restart,
		onremove: (vnode: VnodeDOM) => (vnode as AmbientVnode).state.stop?.(),
	});
}

function editForm({
	element: e,
	mutate,
	variables,
	variableUrl,
}: ElementProps): Vnode {
	const d = DEFAULT_AMBIENT_PROPS;
	const variant = ambientVariant(strProp(e.props, "kind", d.kind));
	return bindableForm({
		element: e,
		mutate,
		variables,
		variableUrl,
		rows: [
			[
				{
					path: "props.kind",
					labelKey: "overlay.ambient_kind",
					type: "select",
					value: strProp(e.props, "kind", d.kind),
					options: AMBIENT_VARIANTS.map((v) => ({
						value: v.id,
						label: t(v.labelKey),
					})),
				},
			],
			// The selected background's own props get their own rows below the
			// kind select (backgrounds without custom props add nothing).
			...(variant?.customFormRows(e).map((field) => [field]) ?? []),
			[
				{
					path: "props.speed",
					labelKey: "overlay.ambient_speed",
					type: "number",
					value: numProp(e.props, "speed", d.speed),
					min: 0.1,
					max: 4,
					step: 0.1,
				},
			],
			[
				{
					path: "props.trail",
					labelKey: "overlay.ambient_trail",
					type: "number",
					value: numProp(e.props, "trail", d.trail),
					min: 1,
					max: 10,
					step: 0.5,
				},
			],
			[
				{
					path: "props.background",
					labelKey: "overlay.ambient_background",
					type: "color",
					value: strProp(e.props, "background", d.background),
				},
			],
		],
	});
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (!ambientVariant(strProp(e.props, "kind", DEFAULT_AMBIENT_PROPS.kind)))
		problems.push("ambient has an unknown background kind");
	return problems;
}

export const ambientElement: OverlayElementDef & OverlayElementSchema = {
	type: "ambient",
	category: "media",

	labelKey: "overlay.add_ambient",
	icon: () => <Icon name="sync" class="role-icon" />,
	order: 10,
	defaultProps: { ...DEFAULT_AMBIENT_PROPS },
	propKeys: [
		"kind",
		"speed",
		"trail",
		"background",
		"trail_faster",
		"head_brightness",
		"circle_count",
		"base_hue",
		"range_hue",
		"base_radius",
		"range_radius",
	],
	defaultSize: { width: 960, height: 540 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(props, read) {
		const d = DEFAULT_AMBIENT_PROPS;
		const kind = read.oneOf("kind", AMBIENT_VARIANT_IDS, d.kind);
		// Normalize the selected background's own props too (stored flat in
		// element.props); unknown/other variants keep only their defaults.
		const variant = ambientVariant(kind);
		const custom = variant?.normalizeCustomProps(props, read) ?? {};
		return {
			kind,
			speed: read.num("speed", d.speed, 0.1, 4),
			trail: read.num("trail", d.trail, 1, 10),
			background: read.hex("background", d.background),
			...custom,
		};
	},
};
