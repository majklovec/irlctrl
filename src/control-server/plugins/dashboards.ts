import { Elysia } from "elysia";
import {
    originAllowed,
    text,
    upgradeRequired,
} from "../../http";
import { widgetHubSnapshot } from "../../registry";
import type { createAuth } from "../auth";
import {
    WIDGET_HUB_TOPIC,
    dashboardsTopic,
    devicesTopic,
    event,
} from "../contracts";
import type { createDashboards } from "../dashboards";
import type { createDevices } from "../devices";
import type { createFrontend } from "../../frontend";
import {
    authenticatedHandler,
    unauthenticatedResponse,
} from "./authenticated";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Dashboards = ReturnType<typeof createDashboards>;
type Devices = ReturnType<typeof createDevices>;
type Frontend = Awaited<ReturnType<typeof createFrontend>>;

export function dashboardRoutes(
    auth: Auth,
    dashboards: Dashboards,
    devices: Devices,
    frontend: Frontend,
) {
    return new Elysia({ name: "control-dashboards" })
        .get(
            "/dashboards/",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("dashboards"),
            ),
        )
        .get(
            "/dashboards/view/*",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("dashboardview"),
            ),
        )
        .get(
            "/dashboards/edit/*",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("dashboardview"),
            ),
        )
        .get(
            "/dashboards/add/*",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("dashboardadd"),
            ),
        )
        .get(
            "/dashboards/ws",
            authenticatedHandler(auth, () => upgradeRequired()),
        )
        .all(
            "/api/dashboards",
            authenticatedHandler(auth, (request, user) =>
                dashboards.dashApi(request, new URL(request.url), user),
            ),
        )
        .all(
            "/api/dashboards/*",
            authenticatedHandler(auth, (request, user) =>
                dashboards.dashApi(request, new URL(request.url), user),
            ),
        )
        .ws("/dashboards/ws", {
            beforeHandle({ request }) {
                if (!auth.userFromRequest(request))
                    return unauthenticatedResponse(auth, request);
                if (!originAllowed(request))
                    return text("Origin not allowed", 403);
            },
            open(ws) {
                const user = auth.userFromRequest(ws.data.request);
                if (!user) return ws.close(1008, "Authentication required");
                ws.subscribe(WIDGET_HUB_TOPIC);
                ws.subscribe(dashboardsTopic(user));
                ws.subscribe(devicesTopic(user));
                ws.send(event("widget.snapshot", widgetHubSnapshot()));
                ws.send(
                    event("dashboards.snapshot", {
                        dashboards: dashboards.dashboardsFor(user),
                    }),
                );
                ws.send(event("devices.snapshot", devices.summaries(user)));
            },
        });
}
