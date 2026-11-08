/*
 * HTTP routes that serve the web UI: the bundled core pages, module pages
 * and the web login (single local account).
 *
 *   GET      /                  index (or the setup wizard while unconfigured)
 *   GET      /settings/         the settings page
 *   GET      /setup/            the setup wizard
 *   GET      /login/            web login
 *   POST     /login             authenticate (JSON {"username", "password"})
 *   POST     /logout            end the current web session
 *   GET      /i18n/:lang        the UI catalog (JSON)
 *   GET/POST /assets/*          JS/CSS chunks emitted by Bun.build
 *   *      anything else under / is a module page
 *
 * Pages are rendered by their own Mithril views (client/frontend/pages/ and
 * modules/<id>/pages/); this file only wires the URLs.
 *
 * Authentication: once the wizard has stored web credentials, every page
 * except /login is guarded and unauthenticated browsers are redirected to
 * /login/. Pages of a fresh (not set up) device stay open — auth is enabled
 * the moment setup.complete stores the password.
 */
import { Elysia } from "elysia";
import type { createFrontend } from "../../../shared/frontend";
import { i18nResponse, notFound } from "../../../shared/http";
import { catalog } from "../../../shared/i18n";
import { modulePage } from "../../../shared/registry";
import {
	authEnabled,
	loginRoute,
	logoutRoute,
	sessionFromRequest,
} from "../auth";
import { setupRequired } from "../state";

type Frontend = Awaited<ReturnType<typeof createFrontend>>;

/** 302 to /login/ for unauthenticated browsers, while credentials are set. */
const needLogin = (req: Request): Response | undefined =>
	authEnabled && !sessionFromRequest(req)
		? Response.redirect("/login/", 302)
		: undefined;

export function devicePagesPlugin(frontend: Frontend) {
	return (
		new Elysia({ name: "device-api-pages" })
			.get("/", ({ request }) => {
				const path = new URL(request.url).pathname;
				if (!path.endsWith("/")) return Response.redirect("/", 308);
				const page = setupRequired ? "setup" : "index";
				return needLogin(request) ?? frontend.htmlResponse(page);
			})
			.get("/assets/*", ({ request }) => {
				const path = new URL(request.url).pathname;
				const asset = frontend.assets.get(path.slice("/assets/".length));
				return asset
					? new Response(asset, {
							headers: {
								"cache-control": "public, max-age=31536000, immutable",
							},
						})
					: notFound();
			})
			.get("/settings", ({ request }) =>
				new URL(request.url).pathname.endsWith("/")
					? (needLogin(request) ?? frontend.htmlResponse("settings"))
					: Response.redirect("/settings/", 308),
			)
			.get("/setup", ({ request }) =>
				new URL(request.url).pathname.endsWith("/")
					? (needLogin(request) ?? frontend.htmlResponse("setup"))
					: Response.redirect("/setup/", 308),
			)
			// Web login (single local account)
			.get("/login", ({ request }) =>
				new URL(request.url).pathname.endsWith("/")
					? frontend.htmlResponse("signin")
					: Response.redirect("/login/", 308),
			)
			.post("/login", ({ request }) => loginRoute(request))
			.post("/logout", ({ request }) => logoutRoute(request))
			.get("/i18n/*", ({ request }) =>
				i18nResponse(new URL(request.url).pathname, catalog),
			)
			// Module-owned pages (modules/<id>/pages/*.html) at the paths they declare
			.all("*", ({ request }) => {
				const path = new URL(request.url).pathname;
				const guarded = needLogin(request);
				if (guarded) return guarded;
				const page = modulePage(path);
				if (!page) return notFound();
				return path.endsWith("/")
					? frontend.htmlResponse(page)
					: Response.redirect(`${path}/`, 308);
			})
	);
}
