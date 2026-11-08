/*
 * The control server app: composes the page modules (server/pages/*) with
 * the auth, static, live-feed and not-found routes. Every entity group
 * (devices, dashboards, overlays, assets) lives in its own page slice;
 * cross-page needs (the module control routes, the overlays' asset-library
 * files, the live feed) are reached through the capability registry, so the
 * core never names a page's store — only the stable capability ids.
 *
 * Composition order (main.ts): createServices → createApp. createApp builds
 * the Elysia root, discovers + mounts the pages, mounts the core routes,
 * listens, then starts the pages' background work.
 */
import { Elysia } from "elysia";
import { notFound } from "../../shared/http";
import { i18nReady } from "../../shared/i18n";
import { pwaRoutes } from "../../shared/pwa";
import {
    ALL_MODULES,
    acquireWidgetChannels,
    releaseWidgetChannels,
    widgetHubSnapshot,
} from "../../shared/registry";
import type { createDashboards } from "../pages/dashboards/backend/registry";
import type { createOverlays } from "../pages/overlays/backend/registry";
import { accountRoutes } from "./auth/account_routes";
import { authenticatedHandler } from "./auth/authenticated";
import { publicRoutes } from "./auth/public_routes";
import { liveFeedRoutes } from "./live_routes";
import { discoverPages, getPages, mountRoutes } from "./registry";
import { WIDGET_HUB_TOPIC } from "./runtime";
import { createServices, type Services } from "./services";
import { staticRoutes } from "./static_routes";

type Dashboards = ReturnType<typeof createDashboards>;
type Overlays = ReturnType<typeof createOverlays>;

/** The bare Elysia root + the publish binding onto it. */
function buildApp(services: Services): Elysia {
    const app = new Elysia({ name: "control-server" });
    // Read `app.server` at publish time: it is only set once listen() ran.
    services.bindPublish({ publish: (t, m) => app.server?.publish(t, m) });
    return app;
}

interface ControlServerOptions {
    hostname?: string;
    port: number;
    noAuth?: boolean;
    databaseFile: string;
    /** Directory the asset files are stored on disk. */
    storageDir: string;
}

export async function createControlServer(options: ControlServerOptions) {
    const services = await createServices({
        hostname: options.hostname,
        port: options.port,
        noAuth: options.noAuth,
        databaseFile: options.databaseFile,
        storageDir: options.storageDir,
    });
    const { auth, frontend } = services;
    await i18nReady;

    const app = buildApp(services);
    await discoverPages(services);
    mountRoutes(app);

    /*
     * The module control routes cross pages: they read the dashboards and
     * overlays stores, now reached through their capabilities.
     */
    const dashboards = services.capabilities.require<Dashboards>("dashboards");
    const overlays = services.capabilities.require<Overlays>("overlays");
    for (const mod of ALL_MODULES) {
        if (mod.controlRoutes)
            app.use(
                mod.controlRoutes({
                    dashboardById: dashboards.dashboardById,
                    htmlResponse: frontend.htmlResponse,
                    widgetHubSnapshot,
                    widgetHubTopic: () => WIDGET_HUB_TOPIC,
                    acquireChatChannels: (specs) =>
                        acquireWidgetChannels("chat", specs),
                    releaseChatChannels: (specs) =>
                        releaseWidgetChannels("chat", specs),
                    overlayChatOverlaySpecs: (token, overlayId) => {
                        const project = auth.projectForToken(token);
                        return project
                            ? overlays.runtimeOverlayChatSpecs(
                                  project,
                                  overlayId,
                              )
                            : null;
                    },
                }),
            );
    }

    app.use(publicRoutes(auth, frontend))
        .use(pwaRoutes())
        .use(accountRoutes(auth, frontend))
        .use(liveFeedRoutes(services))
        .use(await staticRoutes())
        .use(
            new Elysia({ name: "control-not-found" }).all(
                "*",
                authenticatedHandler(auth, () => notFound()),
            ),
        );

    await app.listen({
        hostname: options.hostname,
        port: options.port,
    });

    /*
     * The server is live now — start the pages' background work (the
     * devices page runs its maintenance sweep).
     */
    for (const page of getPages()) await page.backend.start?.(services);

    return app;
}
