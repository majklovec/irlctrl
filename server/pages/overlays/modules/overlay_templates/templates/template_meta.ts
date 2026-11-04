/**
 * Template metadata — types + the fixed vocabulary of params a template
 * may consume.
 *
 * The metadata lives IN each template's document
 * (`assets/overlay_templates/<id>.html`): the name as an
 * `<meta name="name">` tag, and the consumed params
 * (`uses`) DERIVED from the document's own hooks + `:root` vars by
 * `template_doc.ts::parseTemplateDoc` (deriveUses) — nothing is
 * hand-listed.
 */

/** The fixed (non-text) params a template may consume — the vocabulary
 * doc.ts's var/countdown maps + the asset/countdown hooks are built over.
 * The TEXT params are NOT listed here: a template's text slots are its own
 * `data-bind` names (any `data-bind="<slot>"` in the body is a text param —
 * derived from the document, not frozen; `title`/`subtitle` are the
 * conventional slots most templates use). */
export const PARAMS = [
	"accentColor",
	"bgColor",
	"bgAlpha",
	"textColor",
	"fontFamily",
	"fontSize",
	"radius",
	"padding",
	"vars",
	"logoAssetId",
	"mode",
	"targetIso",
] as const;

export type TemplateParam = (typeof PARAMS)[number];

/** A `uses` entry is a text slot when it is one of the template's
 * `data-bind="<name>"` hooks (doc.ts emits its bound text; the inspector
 * renders one field for it) — i.e. not one of the fixed `PARAMS` above. */
export function isTextSlot(param: string): boolean {
	return !PARAMS.includes(param as (typeof PARAMS)[number]);
}

/** Parsed metadata of one template (from its HTML document). */
export interface TemplateMeta {
	/** The file/URL id (`<id>.html` under assets/overlay_templates). */
	id: string;
	/** i18n key of the human name. */
	name: string;
	/** The params the template consumes (derived from its hooks + `:root`):
	 * its `data-bind` text-slot names, then `vars`/`logoAssetId`/
	 * `mode`+`targetIso` when present. Text slots are free-form, so this is
	 * a string list, not the fixed `TemplateParam` union. */
	uses: string[];
}
