import {
    i18nResponse,
    imageResponse,
    notFound,
    originAllowed,
    text,
    upgradeRequired,
} from "../http";
import { catalog, i18nReady } from "../i18n";
import { widgetHubSnapshot } from "../registry";
import { createAuth } from "./auth";
import {
    ID_RE,
    LOCAL_USER,
    WIDGET_HUB_TOPIC,
    dashboardsTopic,
    devicesTopic,
    event,
    type Publish,
    type WsData,
} from "./contracts";
import { createDashboards } from "./dashboards";
import { createDevices } from "./devices";
import { createFrontend, type PageName } from "./frontend";

// /d/<id>[/], /d/<id>/ws, /d/<id>/settings[/], /d/<id>/setup[/]
const DEVICE_PATH_RE = /^\/d\/([^/]+)(?:(\/)(?:(ws)|(settings|setup)(\/)?)?)?$/;
const PIPELINE_EDIT_RE = /^\/d\/([^/]+)\/pipelines\/(new|edit\/[^/]+)\/?$/;

interface ControlServerOptions {
    hostname: string;
    port: number;
    noAuth: boolean;
    databaseFile: string;
    publicDirectory: URL;
}

export async function createControlServer(options: ControlServerOptions) {
    const auth = await createAuth({
        noAuth: options.noAuth,
        databaseFile: options.databaseFile,
    });
    const { assets, htmlResponse } = await createFrontend(
        options.publicDirectory,
    );
    await i18nReady;

    // The hub and registry retain this callback; they publish after listen.
    const publish: Publish = (topic, message) => server.publish(topic, message);
    const devices = createDevices({
        publish,
        userForToken: auth.userForToken,
    });
    const dashboards = createDashboards({
        db: auth.db,
        databaseFile: options.databaseFile,
        publish,
        ownsDevice: devices.ownsDevice,
    });

    /** Pages and the viewer socket of one device (`/d/<id>/...`). */
    function devicePath(
        req: Request,
        url: URL,
        srv: Bun.Server<WsData>,
        m: RegExpMatchArray,
        user: string,
    ): Response | undefined {
        const [, rawId, slash, ws, page, pageSlash] = m;
        const id = decodeURIComponent(rawId);
        if (!ID_RE.test(id)) return text("Invalid device id", 400);
        const d = devices.getDevice(id);
        if (!d || (d.owner ?? LOCAL_USER) !== user) return notFound();
        const base = `/d/${encodeURIComponent(id)}/`;
        if (ws) {
            if (!originAllowed(req)) return text("Origin not allowed", 403);
            if (srv.upgrade(req, { data: { kind: "viewer", id, user } }))
                return undefined;
            return upgradeRequired();
        }
        if (page)
            return pageSlash
                ? htmlResponse(page as PageName)
                : Response.redirect(`${base}${page}/`, 308);
        if (!slash) return Response.redirect(base, 308);
        const setupRequired =
            d.status?.setupRequired && !url.searchParams.has("ui");
        return htmlResponse(setupRequired ? "setup" : "index");
    }

    const server = Bun.serve({
        hostname: options.hostname,
        port: options.port,

        async fetch(req, srv) {
            const url = new URL(req.url);
            const path = url.pathname;

            if (path === "/healthz") return text("ok");
            if (path === "/device") return devices.deviceUpgrade(req, url, srv);

            // Login, registration, assets and catalogs remain public.
            if (path === "/login") {
                if (auth.db && !auth.hasUsers())
                    return Response.redirect("/register", 302);
                return htmlResponse("login");
            }
            if (path === "/register") return htmlResponse("register");
            if (path.startsWith("/assets/")) {
                const asset = assets.get(path.slice("/assets/".length));
                return asset
                    ? new Response(asset, {
                          headers: {
                              "cache-control":
                                  "public, max-age=31536000, immutable",
                          },
                      })
                    : notFound();
            }
            if (path.startsWith("/i18n/"))
                return await i18nResponse(path, catalog);
            if (path === "/api/login" && req.method === "POST")
                return auth.loginResponse(req);
            if (path === "/api/register" && req.method === "POST")
                return auth.registerResponse(req);
            if (path === "/api/register/status" && req.method === "GET")
                return auth.registerStatusResponse();
            if (path === "/api/logout" && req.method === "POST")
                return auth.logoutResponse(req);

            const user = auth.userFromRequest(req);
            if (!user) {
                if (req.method === "GET" && !path.startsWith("/api/"))
                    return Response.redirect(
                        auth.db && !auth.hasUsers() ? "/register" : "/login",
                        302,
                    );
                return auth.unauthorized();
            }

            if (path === "/") return htmlResponse("devices");
            if (path === "/api/devices")
                return Response.json(devices.summaries(user));
            if (path === "/profile/") return htmlResponse("profile");
            if (path === "/profile") return Response.redirect("/profile/", 308);
            if (path === "/api/whoami") return auth.whoamiResponse(user);
            if (path === "/api/profile" && req.method === "GET")
                return auth.profileResponse(user);
            if (path === "/api/profile/password" && req.method === "POST")
                return auth.changePasswordResponse(req, user);
            if (path === "/api/profile/tokens" && req.method === "POST")
                return auth.createTokenResponse(user);
            const tokenDel = path.match(/^\/api\/profile\/tokens\/([^/]+)$/);
            if (tokenDel && req.method === "DELETE")
                return auth.deleteTokenResponse(url, user);
            if (path === "/api/invitations" && req.method === "GET")
                return auth.listInvitationsResponse(req);
            if (path === "/api/invitations" && req.method === "POST")
                return auth.createInvitationResponse(req);
            if (path === "/dashboards/") return htmlResponse("dashboards");
            if (path.startsWith("/api/dashboards"))
                return dashboards.dashApi(req, url, user);
            if (path === "/dashboards/ws") {
                if (!originAllowed(req)) return text("Origin not allowed", 403);
                if (srv.upgrade(req, { data: { kind: "dashboards", user } }))
                    return undefined;
                return upgradeRequired();
            }
            if (
                path.startsWith("/dashboards/view/") ||
                path.startsWith("/dashboards/edit/")
            ) {
                return htmlResponse("dashboardview");
            }
            if (path.startsWith("/dashboards/add/")) {
                return htmlResponse("dashboardadd");
            }
            const pm = path.match(PIPELINE_EDIT_RE);
            if (pm) {
                const id = decodeURIComponent(pm[1]);
                if (!ID_RE.test(id)) return text("Invalid device id", 400);
                const d = devices.getDevice(id);
                if (!d || (d.owner ?? LOCAL_USER) !== user) return notFound();
                return htmlResponse("pipelineedit");
            }
            const m = path.match(DEVICE_PATH_RE);
            if (m) return devicePath(req, url, srv, m, user);
            return (await imageResponse(path)) ?? notFound();
        },

        websocket: {
            data: {} as WsData,

            open(ws) {
                const { data } = ws;
                if (data.kind === "dashboards") {
                    ws.subscribe(WIDGET_HUB_TOPIC);
                    ws.subscribe(dashboardsTopic(data.user));
                    ws.subscribe(devicesTopic(data.user));
                    ws.send(event("widget.snapshot", widgetHubSnapshot()));
                    ws.send(
                        event("dashboards.snapshot", {
                            dashboards: dashboards.dashboardsFor(data.user),
                        }),
                    );
                    ws.send(
                        event("devices.snapshot", devices.summaries(data.user)),
                    );
                    return;
                }
                devices.open(ws);
            },

            message(ws, raw) {
                if (ws.data.kind === "dashboards") return;
                devices.message(ws, raw);
            },

            close(ws, code, reason) {
                if (ws.data.kind === "dashboards") return;
                devices.close(ws, code, reason);
            },
        },
    });

    devices.startMaintenance();
    return server;
}
