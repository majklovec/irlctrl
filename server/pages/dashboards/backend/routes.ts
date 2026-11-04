/*
 * The dashboards page's routes: the four page HTML routes and the editor
 * REST API. The shared live feed (/dashboards/ws) is core-owned
 * (server/core/live_routes.ts) — it serves the devices and overlays pages
 * too, so it is not part of this slice.
 */
import { Elysia } from "elysia";
import type { PageServices } from "../../../core/contracts";
import {
    authenticatedHandler,
} from "../../../core/auth/authenticated";
import type { createDashboards } from "./registry";

type Dashboards = ReturnType<typeof createDashboards>;

export function mountDashboardRoutes(
    routes: Elysia,
    s: PageServices,
    dashboards: Dashboards,
): void {
    const { auth, frontend } = s;
    routes
        .get(
            "/dashboards/",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("dashboard_list"),
            ),
        )
        .get(
            "/dashboards/view/*",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("dashboard_view"),
            ),
        )
        .get(
            "/dashboards/edit/*",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("dashboard_update"),
            ),
        )
        .get(
            "/dashboards/add/*",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("dashboard_add"),
            ),
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
        );
}
