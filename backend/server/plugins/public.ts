import { Elysia } from "elysia";
import type { createFrontend } from "../../../shared/frontend";
import { faviconResponse, notFound, text } from "../../../shared/http";
import type { createAuth } from "../auth";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Frontend = Awaited<ReturnType<typeof createFrontend>>;

export function publicRoutes(auth: Auth, frontend: Frontend) {
	return new Elysia({ name: "control-public" })
		.get("/healthz", () => text("ok"))
		.get("/favicon.ico", () => faviconResponse())
		.get("/login", () =>
			auth.db && !auth.hasUsers()
				? Response.redirect("/register", 302)
				: frontend.htmlResponse("login"),
		)
		.get("/register", () => frontend.htmlResponse("register"))
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
		.post("/api/login", ({ request }) => auth.loginResponse(request))
		.post("/api/register", ({ request }) => auth.registerResponse(request))
		.get("/api/register/status", () => auth.registerStatusResponse())
		.post("/api/logout", ({ request }) => auth.logoutResponse(request));
}
