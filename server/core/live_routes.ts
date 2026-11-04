/*
 * The core live feed: /dashboards/ws is the shared realtime channel of
 * the control UI (widget hub + dashboards + devices snapshots/changes),
 * consumed by the devices, dashboards AND overlays pages — which is why
 * it lives in core rather than in any single page slice.
 */
import { Elysia } from "elysia";
import { originAllowed, text, upgradeRequired } from "../../shared/http";
import { widgetHubSnapshot } from "../../shared/registry";
import type { PageServices } from "./contracts";
import {
    dashboardsTopic,
    devicesTopic,
    event,
    WIDGET_HUB_TOPIC,
} from "./runtime";
import {
    authenticatedHandler,
    unauthenticatedResponse,
} from "./auth/authenticated";

interface DashboardsFeed {
    dashboardsFor(user: string): unknown;
}
interface DevicesFeed {
    summaries(user: string): unknown;
}

export function liveFeedRoutes(s: PageServices) {
    const { auth, capabilities } = s;

    return new Elysia({ name: "control-live-feed" })
        .get(
            "/dashboards/ws",
            authenticatedHandler(auth, () => upgradeRequired()),
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
                const dashboards = capabilities.require<DashboardsFeed>(
                    "dashboards",
                );
                const devices = capabilities.require<DevicesFeed>("devices");

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
