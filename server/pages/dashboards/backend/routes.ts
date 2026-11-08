/*
 * The dashboards page's routes: the four page HTML routes and the editor
 * REST API. The shared live feed (/dashboards/ws) is core-owned
 * (server/core/live_routes.ts) — it serves the devices and overlays pages
 * too, so it is not part of this slice.
 */
import { Elysia } from "elysia";
import type { PageServices, ProjectAccess } from "../../../core/contracts";
import { apiGuard, scopedProject } from "../../../core/project_scope";
import {
    authenticatedHandler,
} from "../../../core/auth/authenticated";
import type { createDashboards } from "./registry";

type Dashboards = ReturnType<typeof createDashboards>;

/** View any dashboard the request's project can read; edit needs editor+. */
const READ_ROLES = ["viewer", "editor", "owner"] as const;
const EDIT_ROLES = ["editor", "owner"] as const;

export function mountDashboardRoutes(
    routes: Elysia,
    s: PageServices,
    dashboards: Dashboards,
): void {
    const { auth, capabilities, frontend } = s;
    const access = capabilities.require<ProjectAccess>("projectAccess");
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
                apiGuard(() => {
                    const url = new URL(request.url);
                    const projectId = scopedProject(
                        access,
                        url,
                        user,
                        request.method === "GET" ? READ_ROLES : EDIT_ROLES,
                    );
                    return dashboards.dashApi(request, url, projectId);
                }),
            ),
        )
        .all(
            "/api/dashboards/*",
            authenticatedHandler(auth, (request, user) =>
                apiGuard(() => {
                    const url = new URL(request.url);
                    const projectId = scopedProject(
                        access,
                        url,
                        user,
                        request.method === "GET" ? READ_ROLES : EDIT_ROLES,
                    );
                    return dashboards.dashApi(request, url, projectId);
                }),
            ),
        );
}
