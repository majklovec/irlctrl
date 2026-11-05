/*
 * Templates routes:
 *   GET    /templates/            the templates editor page (cookie auth)
 *   GET    /api/templates         the template list (summaries, cookie auth)
 *   GET    /api/templates/:id     one template (summary + html, cookie auth)
 *   POST   /api/templates         {id, html?} create (html omitted = starter)
 *   PUT    /api/templates/:id     {html} replace the content
 *   DELETE /api/templates/:id
 *
 * The files live in the storage dir (assets/overlay_templates); the
 * control server serves the same directory at /overlay_templates/*, so a
 * saved template is live for the OBS runtime with no reload.
 */
import { Elysia } from "elysia";
import { ApiError } from "../../../../shared/params";
import { authenticatedHandler } from "../../../core/auth/authenticated";
import type { PageServices } from "../../../core/contracts";
import type {
	TemplateDetail,
	TemplateStore,
	TemplateSummary,
} from "./registry";

const TEMPLATE_ID_RE = /^\/api\/templates\/([a-z0-9_]{1,64})$/;

/** Run `fn` and map its outcome: ApiError → `{ok:false, error, code}`. */
async function run(
	fn: () =>
		| { status?: number; body: Record<string, unknown> }
		| Promise<{ status?: number; body: Record<string, unknown> }>,
): Promise<Response> {
	try {
		const result = await fn();
		return Response.json(result.body, { status: result.status ?? 200 });
	} catch (err: unknown) {
		const code = err instanceof ApiError ? err.code : 500;
		return Response.json(
			{
				ok: false,
				error: err instanceof Error ? err.message : "Internal error",
				code,
			},
			{ status: code },
		);
	}
}

export function mountTemplateRoutes(
	routes: Elysia,
	s: PageServices,
	templates: TemplateStore,
): void {
	const { auth, frontend } = s;
	const summary = (t: TemplateSummary): Record<string, unknown> => ({ ...t });
	const detail = (t: TemplateDetail): Record<string, unknown> => ({
		template: { ...t.summary, html: t.html },
	});

	routes
		.get(
			"/templates/",
			authenticatedHandler(auth, () => frontend.htmlResponse("template_list")),
		)
		.get(
			"/api/templates",
			authenticatedHandler(auth, () =>
				run(() => ({
					body: { templates: templates.list().map(summary) },
				})),
			),
		)
		.get(
			"/api/templates/*",
			authenticatedHandler(auth, (request) => {
				const match = new URL(request.url).pathname.match(TEMPLATE_ID_RE);
				if (!match)
					return Response.json(
						{ ok: false, error: "Not found", code: 404 },
						{ status: 404 },
					);
				return run(() => ({ body: detail(templates.get(match[1])) }));
			}),
		)
		.post(
			"/api/templates",
			authenticatedHandler(auth, async (request) => {
				const body = (await request.json().catch(() => null)) as {
					id?: unknown;
					html?: unknown;
				} | null;
				const id = typeof body?.id === "string" ? body.id : "";
				const html =
					typeof body?.html === "string" && body.html !== ""
						? body.html
						: undefined;
				return run(() => {
					if (!id) throw new ApiError("id is required");
					return {
						status: 201,
						body: detail(templates.create(id, html ?? "")),
					};
				});
			}),
		)
		.put(
			"/api/templates/*",
			authenticatedHandler(auth, async (request) => {
				const match = new URL(request.url).pathname.match(TEMPLATE_ID_RE);
				if (!match)
					return Response.json(
						{ ok: false, error: "Not found", code: 404 },
						{ status: 404 },
					);
				const body = (await request.json().catch(() => null)) as {
					html?: unknown;
				} | null;
				const html = body?.html;
				return run(() => {
					if (typeof html !== "string" || html === "")
						throw new ApiError("html is required");
					return { body: detail(templates.save(match[1], html)) };
				});
			}),
		)
		.delete(
			"/api/templates/*",
			authenticatedHandler(auth, (request) => {
				const match = new URL(request.url).pathname.match(TEMPLATE_ID_RE);
				if (!match)
					return Response.json(
						{ ok: false, error: "Not found", code: 404 },
						{ status: 404 },
					);
				return run(() => {
					templates.remove(match[1]);
					return { body: { ok: true } };
				});
			}),
		);
}
