/*
 * Central control server: compose HTTP and WebSocket domains as Elysia plugins.
 * Devices connect with `client.ts --remote ws(s)://host:port/device`.
 */
import { Elysia } from "elysia";
import { i18nReady } from "../../shared/i18n";
import { notFound } from "../../shared/http";
import type { Publish } from "./contracts";
import { createAuth } from "./auth";
import { createDashboards } from "./dashboards";
import { createDevices } from "./devices";
import { createFrontend } from "../../shared/frontend";
import { accountRoutes } from "./plugins/account";
import { authenticatedHandler } from "./plugins/authenticated";
import { dashboardRoutes } from "./plugins/dashboards";
import { deviceConnectionRoutes } from "./plugins/device-connection";
import { deviceListRoutes } from "./plugins/device-list";
import { devicePageRoutes } from "./plugins/device-pages";
import { deviceViewerRoutes } from "./plugins/device-viewers";
import { imageRoutes } from "./plugins/images";
import { publicRoutes } from "./plugins/public";

interface ControlServerOptions {
    hostname: string;
    port: number;
    noAuth: boolean;
    databaseFile: string;
    frontendDirectory: URL;
}

export async function createControlServer(options: ControlServerOptions) {
    const auth = await createAuth({
        noAuth: options.noAuth,
        databaseFile: options.databaseFile,
    });
    const frontend = await createFrontend(options.frontendDirectory);
    await i18nReady;

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
    });

    app.use(publicRoutes(auth, frontend))
        .use(accountRoutes(auth, frontend))
        .use(dashboardRoutes(auth, dashboards, devices, frontend))
        .use(deviceListRoutes(auth, devices))
        .use(deviceConnectionRoutes(devices))
        .use(deviceViewerRoutes(auth, devices))
        .use(devicePageRoutes(auth, devices, frontend))
        .use(imageRoutes(auth))
        .use(
            new Elysia({ name: "control-not-found" })
                .all(
                    "*",
                    authenticatedHandler(auth, () => notFound()),
                ),
        );

    app.listen({ hostname: options.hostname, port: options.port });
    devices.startMaintenance();
    return app;
}
