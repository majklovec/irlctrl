/*
 * Central control server: compose HTTP and WebSocket domains as Elysia plugins.
 * Devices connect with `client.ts --remote ws(s)://host:port/device`.
 */
import { Elysia } from "elysia";
import { createFrontend } from "../../shared/frontend";
import { notFound } from "../../shared/http";
import { i18nReady } from "../../shared/i18n";
import { pwaRoutes } from "../../shared/pwa";
import {
    acquireWidgetChannels,
    ALL_MODULES,
    releaseWidgetChannels,
    widgetHubSnapshot,
} from "../../shared/registry";
import { assetRoutes } from "./assets/asset_routes";
import { createAssets } from "./assets/asset_store";
import { accountRoutes } from "./auth/account_routes";
import { createAuth } from "./auth/auth";
import { authenticatedHandler } from "./auth/authenticated";
import { publicRoutes } from "./auth/public_routes";
import { type Publish, WIDGET_HUB_TOPIC } from "./contracts";
import { dashboardRoutes } from "./dashboards/dashboard_routes";
import { createDashboards } from "./dashboards/dashboard_store";
import { deviceConnectionRoutes } from "./devices/device_connection_routes";
import { deviceListRoutes } from "./devices/device_list_routes";
import { devicePageRoutes } from "./devices/device_page_routes";
import { createDevices } from "./devices/device_registry";
import { deviceViewerRoutes } from "./devices/device_viewer_routes";
import { overlayRoutes } from "./overlays/overlay_routes";
import { createOverlays } from "./overlays/overlay_store";
import { staticRoutes } from "./static_routes";

interface ControlServerOptions {
    hostname: string;
    port: number;
    noAuth: boolean;
    databaseFile: string;
    /** Directory the asset files are stored on disk. */
    storageDir: string;
}

export async function createControlServer(options: ControlServerOptions) {
    const auth = await createAuth({
        noAuth: options.noAuth,
        databaseFile: options.databaseFile,
    });
    const frontend = await createFrontend();
    await i18nReady;
    const assets = createAssets({
        db: auth.db,
        storageDir: options.storageDir,
    });

    const app = new Elysia({ name: "control-server" });
    const publish: Publish = (topic, message) => {
        app.server?.publish(topic, message);
    };
    const devices = createDevices({
        publish,
        userForToken: auth.userForToken,
    });
    const dashboards = createDashboards({
        db: auth.db,
        databaseFile: options.databaseFile,
        publish,
        ownsDevice: devices.ownsDevice,
        deviceExists: (id) => !!devices.getDevice(id),
        deviceStatus: (id) => devices.getDevice(id)?.status,
    });
    const overlays = createOverlays({
        db: auth.db,
        databaseFile: options.databaseFile,
        publish,
    });

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
                    overlayChatOverlaySpecs: (token, overlayId) =>
                        overlays.runtimeOverlayChatSpecs(token, overlayId),
                }),
            );
    }

    app.use(publicRoutes(auth, frontend))
        .use(pwaRoutes())
        .use(accountRoutes(auth, frontend))
        .use(dashboardRoutes(auth, dashboards, devices, frontend))
        .use(overlayRoutes(auth, overlays, assets, frontend))
        .use(assetRoutes(auth, assets, frontend))
        .use(deviceListRoutes(auth, devices, frontend))
        .use(deviceConnectionRoutes(devices))
        .use(deviceViewerRoutes(auth, devices))
        .use(devicePageRoutes(auth, devices, frontend))
        .use(await staticRoutes())
        .use(
            new Elysia({ name: "control-not-found" }).all(
                "*",
                authenticatedHandler(auth, () => notFound()),
            ),
        );

    app.listen({ hostname: options.hostname, port: options.port });
    devices.startMaintenance();
    return app;
}
