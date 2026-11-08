/*
 * Project-scoping guards shared by every project-scoped page (devices,
 * dashboards, overlays, assets). A route resolves the target project — the
 * `?project=` query param, else the requesting user's Personal project (a
 * 404 when they have none) — and enforces the requested roles through the
 * "projectAccess" capability before dispatching to its store. Stores take the
 * resolved project id and scope their queries to it without doing auth
 * themselves.
 */
import { ApiError } from "../../shared/params";
import { projectParam } from "../../shared/project_param";
import type { ProjectAccess, ProjectRole } from "./contracts";

/**
 * Run `fn`, mapping a thrown `ApiError` (and any other unexpected error) to a
 * JSON error response. Routes whose guards (`scopedProject`) throw `ApiError`
 * wrap their handler in this so denials surface as proper 4xx responses.
 */
export function apiGuard(
    fn: () => Response | Promise<Response>,
): Promise<Response> {
    return Promise.resolve()
        .then(fn)
        .catch((err: unknown): Response => {
            const status = err instanceof ApiError ? err.code : 500;
            return Response.json(
                {
                    ok: false,
                    error:
                        err instanceof Error ? err.message : "Internal error",
                    code: status,
                },
                { status },
            );
        });
}

/**
 * Resolve the project a request targets (`?project=`, else the user's Personal
 * project) and enforce the requested roles — throwing `ApiError` on a missing
 * project / non-member / insufficient role, so the caller continues only when
 * authorized and scopes its store calls to the returned project id.
 */
export function scopedProject(
    access: ProjectAccess,
    url: URL,
    user: string,
    roles: readonly ProjectRole[],
): string {
    const projectId = projectParam(url) ?? access.personalProjectId(user);
    access.requireRole(user, projectId, roles);
    return projectId;
}
