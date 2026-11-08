/*
 * The projects page (TODO/01-projects.md): the general-purpose projects a
 * user owns or is invited into — membership with roles (owner / editor /
 * viewer) and the single-use invite links that share them. Projects are a
 * cross-cutting container (dashboards, devices and overlays scope onto
 * them gradually), so the management UI lives here, next to the store the
 * invite links and the project selector (the shell nav) both talk to.
 */
import { Elysia } from "elysia";
import { LOCAL_PROJECT_ID } from "../../core/runtime";
import type {
    PageModule,
    PageServices,
    ProjectAccess,
} from "../../../core/contracts";
import { createProjects } from "./backend/registry";
import { mountProjectRoutes } from "./backend/routes";
import menu from "./frontend/menu";

const routes = new Elysia({ name: "page-projects" });

export default {
    id: "projects",
    menu,
    backend: {
        routes,
        init: async (s: PageServices) => {
            const projects = createProjects(s.db);
            // The authorization surface every project-scoped page pulls from
            // this capability (contract: core/contracts.ts `ProjectAccess`).
            // Params annotated explicitly: the `PageServices`/`ProjectAccess`
            // types come from core/contracts, which the page-level tsc quirk
            // (TS2307) leaves as `any` — unannotated params would be implicit
            // any and add new diagnostics to the baseline.
            // No-auth mode has a single local actor: the guard is a no-op and
            // everything lives in the local project (no membership tables).
            const access: ProjectAccess = s.db
                ? {
                    role: (user: string, projectId: string) =>
                        projects.role(user, projectId),
                    requireRole: (
                        user: string,
                        projectId: string,
                        allowed: readonly (
                            | "owner"
                            | "editor"
                            | "viewer"
                        )[],
                    ) => projects.requireRole(user, projectId, allowed),
                    personalProjectId: (user: string) =>
                        projects.personalProjectId(user),
                }
                : {
                    role: () => "owner",
                    requireRole: () => "owner",
                    personalProjectId: () => LOCAL_PROJECT_ID,
                };
            s.capabilities.provide("projectAccess", access);
            mountProjectRoutes(routes, s, projects);
        },
    },
    frontend: {
        pages: ["projects_list"],
    },
} satisfies PageModule;
