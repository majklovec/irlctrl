/**
 * Template metadata — types + the fixed vocabulary of params a template may
 * declare in its HTML document.
 *
 * The metadata itself (name, uses) lives IN each template's document
 * (`public/overlay_templates/<id>/index.html`) as
 * `<meta name="overlay-template:*">` tags; `template_doc.ts::parseTemplateDoc`
 * extracts it at runtime and validates it against `PARAMS` here.
 */

/** Every param a template may declare in its `overlay-template:uses` list
 * (the same vocabulary doc.ts's writers/text/asset maps are built over). */
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

/** Parsed metadata of one template (from its HTML document's meta tags). */
export interface TemplateMeta {
	/** The folder/URL id (directory under public/overlay_templates). */
	id: string;
	/** i18n key of the human name. */
	name: string;
	/** The template's declared params (validated against PARAMS). */
	uses: TemplateParam[];
}
