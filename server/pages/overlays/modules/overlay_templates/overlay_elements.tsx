/*
 * The html_template overlay element (browser half): rendering + inspector.
 * Its schema (the environment-free half used by the scene validator) is in
 * overlay_schema.ts; the document builder + template catalog under
 * templates/ and doc.ts/catalog.ts.
 */
import { htmlTemplateElement } from "./element";

export default [htmlTemplateElement];
