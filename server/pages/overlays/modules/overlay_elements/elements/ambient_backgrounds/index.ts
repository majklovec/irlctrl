/**
 * Ambient background catalog — the module's extensibility point.
 *
 * One class per background (an `AmbientVariant` subclass, see `engine.ts`);
 * registering a new one is a class file + one `new` entry in
 * `AMBIENT_VARIANTS` — the element def, the edit form (its select is built
 * from this list) and the server-side normalization read the ids from here,
 * so nothing else changes.
 *
 * A background owns its own props on its class (`customDefaults` +
 * `normalizeCustomProps` + `customFormRows`): the element stores them flat in
 * `element.props`, renders the form rows only for the selected variant and
 * normalizes them server-side. They reach the background as `opts.custom`
 * (merged over `customDefaults`).
 */

import { Aurora } from "./aurora";
import { Coalesce } from "./coalesce";
import { AmbientVariant } from "./engine";
import { Pipeline } from "./pipeline";
import { Shift } from "./shift";
import { Swirl } from "./swirl";

/** Re-export the base class (the element imports its type from this barrel). */
export { AmbientVariant };

/** The registered backgrounds, in the order they appear in the edit form. */
export const AMBIENT_VARIANTS: readonly AmbientVariant[] = [
	new Aurora(),
	new Coalesce(),
	new Pipeline(),
	new Shift(),
	new Swirl(),
];

/** Variant ids, for `normalizeProps` (oneOf) — never duplicated by hand. */
export const AMBIENT_VARIANT_IDS: readonly string[] = AMBIENT_VARIANTS.map(
	(v) => v.id,
);

/** Resolve a stored variant id to its definition (undefined when unknown). */
export function ambientVariant(id: string): AmbientVariant | undefined {
	return AMBIENT_VARIANTS.find((v) => v.id === id);
}
