/*
 * PWA routes shared by the control server (backend/server) and the device API
 * (backend/client): the service worker and the home-screen icons. The service
 * worker must answer at the origin root (`/sw.js`, scope `/`) to control the
 * whole UI, and the manifest names the icons by fixed path, so these are
 * explicit routes rather than part of the hashed `/assets/*` bundle (the
 * manifest itself is bundled with the pages — see `<link rel="manifest">` in
 * frontend/*.html — and served from `/assets/`).
 *
 * The files are imported with Bun's `file` loader: unbundled this resolves to
 * their path under frontend/pwa/, in the compiled binary they are embedded and
 * resolve into Bun's virtual file system — either way `Bun.file()` serves them.
 */
import { Elysia } from "elysia";
import icon192 from "../frontend/pwa/icons/icon-192.png" with {
	type: "file",
};
import icon512 from "../frontend/pwa/icons/icon-512.png" with {
	type: "file",
};
import serviceWorker from "../frontend/pwa/sw.js" with { type: "file" };
import { notFound } from "./http";

const ICONS: Record<string, string> = {
	"icon-192.png": icon192,
	"icon-512.png": icon512,
};

const serve = (path: string, contentType: string, cacheControl: string) =>
	new Response(Bun.file(path), {
		headers: { "content-type": contentType, "cache-control": cacheControl },
	});

export function pwaRoutes() {
	return (
		new Elysia({ name: "pwa" })
			// `no-cache` so the browser revalidates the worker on every registration check.
			.get("/sw.js", () =>
				serve(
					serviceWorker,
					"application/javascript; charset=utf-8",
					"no-cache",
				),
			)
			.get("/icons/:name", ({ params }) => {
				const path = ICONS[params.name];
				return path
					? serve(path, "image/png", "public, max-age=86400")
					: notFound();
			})
	);
}
