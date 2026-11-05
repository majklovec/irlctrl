/*
 * The templates page: the HTML overlay templates (the OBS html_template
 * documents) edited as files in the storage dir (assets/overlay_templates) —
 * the same directory the control server serves at /overlay_templates/*, so a
 * save here is live for the runtime with no reload. The store is
 * file-backed (one <id>.html per template); the strict document contract
 * (backend/template_doc.ts) is the write gate.
 */

import { join } from "node:path";
import { Elysia } from "elysia";
import type { PageModule, PageServices } from "../../../core/contracts";
import { createTemplateStore } from "./backend/registry";
import { mountTemplateRoutes } from "./backend/routes";
import menu from "./frontend/menu";

const routes = new Elysia({ name: "page-templates" });

export default {
	id: "templates",
	menu,
	backend: {
		routes,
		init: async (s: PageServices) => {
			const templates = createTemplateStore({
				dir: join(s.config.storageDir, "overlay_templates"),
			});
			mountTemplateRoutes(routes, s, templates);
		},
	},
	frontend: {
		pages: ["template_list"],
	},
} satisfies PageModule;
