/*
 * Templates store: one self-contained `<id>.html` file per template in the
 * storage dir (assets/overlay_templates by default) — the same files the
 * control server's `/overlay_templates/*` static route serves and the
 * OBS runtime fetches at runtime. No database: the file IS the state, so
 * the store is a thin, synchronous layer over node:fs.
 *
 * Writes are gated by the strict document contract (template_doc.ts):
 * create and save refuse a document the runtime cannot render, so the
 * storage dir can never hold a half-broken template.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ApiError } from "../../../../shared/params";
import {
	describeTemplateDoc,
	parseTemplateDoc,
	TEMPLATE_ID_RE,
} from "./template_doc";

export interface TemplateSummary {
	/** The template id (the file name minus `.html`). */
	id: string;
	/** The `<meta name="name">` i18n key ("" when the doc is broken). */
	name: string;
	/** The file size in bytes. */
	size: number;
	/** The file's last modification (epoch ms). */
	updatedAt: number;
	/** The `:root` custom properties (name + fallback value). */
	vars: [string, string][];
	/** The `data-bind` slot names (first-seen, deduplicated). */
	binds: string[];
	/** False when the file breaks the template contract. */
	valid: boolean;
	/** The contract breach, when `valid` is false. */
	error?: string;
}

/** The summary + the whole file content (the editor). */
export interface TemplateDetail {
	summary: TemplateSummary;
	html: string;
}

export interface TemplateStore {
	/** Every template, sorted by id. */
	list(): TemplateSummary[];
	/** One template (404 when missing). */
	get(id: string): TemplateDetail;
	/**
	 * Create a template from `html` (400 on a bad id, a contract breach,
	 * 409 when the id already exists).
	 */
	create(id: string, html: string): TemplateDetail;
	/** Replace a template's content (404 when missing, 400 on a breach). */
	save(id: string, html: string): TemplateDetail;
	/** Delete a template (404 when missing). */
	remove(id: string): void;
}

/** The starter document a new template is created from: the full contract
 * (name meta, :root vars, one data-bind slot) with neutral placeholder
 * content the author replaces in the editor. */
export function starterTemplate(id: string): string {
	return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="name" content="overlay.tpl.${id}" />
    <style>
		:root {
			--accent: #6c5ce7;
			--bg: rgba(15, 15, 25, 0.92);
			--text: #ffffff;
		}

		section {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
		}

		.title {
			color: var(--text);
			font-size: 32px;
			font-weight: 700;
			padding: 24px;
		}
	</style>
  </head>
  <body>
	<section>
	    <div class="title" data-bind="title">Title</div>
	</section>
  </body>
</html>
`;
}

export function createTemplateStore({ dir }: { dir: string }): TemplateStore {
	// The storage dir is created eagerly: the static route and the catalog
	// expect the directory to exist even on a fresh deployment.
	mkdirSync(dir, { recursive: true });

	const fileOf = (id: string): string => join(dir, `${id}.html`);
	const isTemplateFile = (name: string): boolean =>
		name.endsWith(".html") &&
		TEMPLATE_ID_RE.test(name.slice(0, -".html".length));

	const detailOf = (id: string): TemplateDetail => {
		const path = fileOf(id);
		if (!existsSync(path)) throw new ApiError(`Template ${id} not found`, 404);
		const html = readFileSync(path, "utf8");
		const doc = describeTemplateDoc(id, html);
		const stat = statSync(path);
		return {
			summary: {
				id,
				name: doc.name,
				size: stat.size,
				updatedAt: stat.mtimeMs,
				vars: doc.vars,
				binds: doc.binds,
				valid: doc.valid,
				...(doc.error !== undefined ? { error: doc.error } : {}),
			},
			html,
		};
	};

	const write = (id: string, html: string): TemplateDetail => {
		// The strict gate: a document the runtime cannot render is refused.
		try {
			parseTemplateDoc(id, html);
		} catch (err) {
			throw new ApiError(
				err instanceof Error ? err.message : "Invalid template document",
			);
		}
		writeFileSync(fileOf(id), html);
		return detailOf(id);
	};

	return {
		list: () =>
			readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isFile() && isTemplateFile(e.name))
				.map((e) => e.name.slice(0, -".html".length))
				.sort()
				.map((id) => detailOf(id).summary),
		get: detailOf,
		create: (id, html) => {
			if (!TEMPLATE_ID_RE.test(id))
				throw new ApiError(
					"Template ids are lowercase letters, digits and underscores",
				);
			if (!existsSync(fileOf(id)))
				return write(id, html || starterTemplate(id));
			throw new ApiError(`Template ${id} already exists`, 409);
		},
		save: (id, html) => {
			detailOf(id); // 404 before the write
			return write(id, html);
		},
		remove: (id) => {
			const path = fileOf(id);
			if (!existsSync(path))
				throw new ApiError(`Template ${id} not found`, 404);
			unlinkSync(path);
		},
	};
}
