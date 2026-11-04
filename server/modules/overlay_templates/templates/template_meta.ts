/**
 * Template metadata — types + the fixed vocabulary of params a template
 * may consume.
 *
 * The metadata lives IN each template's document
 * (`public/overlay_templates/<id>/index.html`): the name as an
 * `<meta name="overlay-template:name">` tag, and the consumed params
 * (`uses`) DERIVED from the document's own hooks + `:root` vars by
 * `template_doc.ts::parseTemplateDoc` (deriveUses) — nothing is
 * hand-listed.
 */

/** Every param a template may consume (the same vocabulary doc.ts's
 * writers/text/asset maps are built over). */
export const PARAMS = [
	"title",
	"subtitle",
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

/** Parsed metadata of one template (from its HTML document). */
export interface TemplateMeta {
	/** The folder/URL id (directory under public/overlay_templates). */
	id: string;
	/** i18n key of the human name. */
	name: string;
	/** The params the template consumes (derived from its hooks + `:root`). */
	uses: TemplateParam[];
}
