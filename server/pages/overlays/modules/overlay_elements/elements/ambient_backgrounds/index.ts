/**
 * Ambient background catalog — the module's extensibility point.
 *
 * One file per background (createAmbient implementation, see
 * `engine.ts`); registering a new one is a file here + one entry in
 * `AMBIENT_VARIANTS` — the element def, the edit form (its select is built
 * from this list) and the server-side normalization read the ids from
 * here, so nothing else changes.
 *
 * A background may also declare its own props on its entry
 * (`customDefaults` + `normalizeCustomProps` + `customFormRow`): the
 * element stores them flat in `element.props`, renders the form row only
 * for the selected variant and normalizes them server-side. They reach the
 * background as `opts.custom` (merged over `customDefaults`).
 */

import type { OverlayElement } from "@ui/overlay/element";
import type { FormField } from "@ui/overlay/fields";
import type { PropReaders } from "../../../../../core/overlay_element";
import { createAurora } from "./aurora";
import { createCoalesce } from "./coalesce";
import type { CreateAmbient } from "./engine";
import {
	createPipeline,
	normalizePipelineCustomProps,
	PIPELINE_CUSTOM_DEFAULTS,
	pipelineCustomFormRow,
} from "./pipeline";
import { createShift } from "./shift";
import { createSwirl } from "./swirl";

export interface AmbientVariant {
	/** Stable id stored in `props.variant`. */
	id: string;
	/** i18n key of the variant's label in the edit form. */
	labelKey: string;
	/** Start the background on the engine's canvases; returns a stop fn. */
	create: CreateAmbient;
	/** Defaults of this background's own props — stored flat in
	 * `element.props` (the key in `trail_faster`'s case). Omit for the
	 * shared `speed`/`trail`/`background` trio only. */
	customDefaults?: Record<string, number>;
	/** Coerce the background's custom props to safe values (server-side). */
	normalizeCustomProps?: (
		props: Readonly<Record<string, unknown>>,
		read: PropReaders,
	) => Record<string, number>;
	/** The background's rows in the element's edit form (rendered only when
	 * it is the selected variant; one row per field). */
	customFormRow?: (element: OverlayElement) => FormField[];
}

export const AMBIENT_VARIANTS: readonly AmbientVariant[] = [
	{ id: "aurora", labelKey: "overlay.ambient_aurora", create: createAurora },
	{
		id: "coalesce",
		labelKey: "overlay.ambient_coalesce",
		create: createCoalesce,
	},
	{
		id: "pipeline",
		labelKey: "overlay.ambient_pipeline",
		create: createPipeline,
		customDefaults: PIPELINE_CUSTOM_DEFAULTS,
		normalizeCustomProps: normalizePipelineCustomProps,
		customFormRow: pipelineCustomFormRow,
	},
	{ id: "shift", labelKey: "overlay.ambient_shift", create: createShift },
	{ id: "swirl", labelKey: "overlay.ambient_swirl", create: createSwirl },
];

/** Variant ids, for `normalizeProps` (oneOf) — never duplicated by hand. */
export const AMBIENT_VARIANT_IDS: readonly string[] = AMBIENT_VARIANTS.map(
	(v) => v.id,
);

/** Resolve a stored variant id to its definition (undefined when unknown). */
export function ambientVariant(id: string): AmbientVariant | undefined {
	return AMBIENT_VARIANTS.find((v) => v.id === id);
}
