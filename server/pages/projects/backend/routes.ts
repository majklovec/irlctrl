/*
 * Projects routes (TODO/01-projects.md):
 *   GET    /projects/                 the projects page (cookie auth)
 *   GET    /projects/join/<token>     the invite-accept page
 *   GET    /api/projects              the user's projects `[{id, name, role}]`
 *   POST   /api/projects              {name} → create (creator becomes owner)
 *   PATCH  /api/projects/:id          {name} → rename (owner / editor)
 *   DELETE /api/projects/:id          delete (owner)
 *   GET    /api/projects/:id/members  `[{userId, login, role}]`
 *   PATCH  /api/projects/:id/members/:userId  {role} (owner)
 *   DELETE /api/projects/:id/members/:userId  (owner; the owner row is fixed)
 *   POST   /api/projects/:id/invites  {role} → {invite} (owner / editor)
 *   GET    /api/projects/:id/invites  `[{...}]` (owner)
 *   DELETE /api/projects/:id/invites/:inviteId (owner)
 *   POST   /api/projects/join/:token  accept an invite → {project}
 *   GET    /api/projects/:id/tokens   `[{id, token, createdAt}]` (any member)
 *   POST   /api/projects/:id/tokens   → {token} (owner / editor)
 *   DELETE /api/projects/:id/tokens/:tokenId  (owner / editor)
 *
 * The authorization rules live in the store (backend/registry.ts); these
 * handlers only parse the request and translate its outcome into JSON.
 */
import { Elysia } from "elysia";
import { ApiError } from "../../../../shared/params";
import { authenticatedHandler } from "../../../core/auth/authenticated";
import type { PageServices } from "../../../core/contracts";
import type { InviteRole, Projects } from "./registry";

/** `/api/projects/<id>[/<sub>[/<tail>]]` */
const PROJECT_PATH_RE =
    /^\/api\/projects\/([\w.-]{1,64})(?:\/([^/]+)(?:\/([^/]+))?)?$/;

async function readJson(
    request: Request,
): Promise<Record<string, unknown> | null> {
    const body = (await request
        .json()
        .catch(() => null)) as Record<string, unknown> | null;
    return body && typeof body === "object" ? body : null;
}

/** Run `fn` and map its outcome: ApiError → `{ok:false, error, code}`. */
async function run(
    fn: () =>
        | { status?: number; body: Record<string, unknown> }
        | Promise<{ status?: number; body: Record<string, unknown> }>,
): Promise<Response> {
    try {
        const result = await fn();
        return Response.json(result.body, { status: result.status ?? 200 });
    } catch (err: unknown) {
        const code = err instanceof ApiError ? err.code : 500;
        return Response.json(
            {
                ok: false,
                error: err instanceof Error ? err.message : "Internal error",
                code,
            },
            { status: code },
        );
    }
}

export function mountProjectRoutes(
    routes: Elysia,
    s: PageServices,
    projects: Projects,
): void {
    const { auth, frontend } = s;
    const origin = (request: Request): string => {
        const url = new URL(request.url);
        return `${url.protocol}//${url.host}`;
    };

    routes
        .get(
            "/projects/",
            authenticatedHandler(
                auth,
                () => frontend.htmlResponse("projects_list"),
            ),
        )
        .get(
            "/projects/join/*",
            authenticatedHandler(
                auth,
                () => frontend.htmlResponse("projects_list"),
            ),
        )
        .get(
            "/api/projects",
            authenticatedHandler(auth, (_request, user) =>
                run(() => ({ body: { projects: projects.list(user) } })),
            ),
        )
        .post(
            "/api/projects",
            authenticatedHandler(auth, async (request, user) => {
                const body = await readJson(request);
                return run(() => {
                    const project = projects.create(
                        user,
                        body?.name,
                    );
                    return { status: 201, body: { project } };
                });
            }),
        )
        .get(
            "/api/projects/*",
            authenticatedHandler(auth, (request, user) => {
                const match = new URL(request.url).pathname.match(
                    PROJECT_PATH_RE,
                );
                if (!match) return notFound();
                const id = match[1] ?? "";
                const sub = match[2];
                if (sub === "members")
                    return run(() => ({
                        body: { members: projects.members(id) },
                    }));
                if (sub === "invites")
                    return run(() => ({
                        body: {
                            invites: projects.listInvites(
                                user,
                                id,
                                origin(request),
                            ),
                        },
                    }));
                if (sub === "tokens")
                    return run(() => ({
                        body: {
                            tokens: projects.listTokens(user, id),
                        },
                    }));
                return notFound();
            }),
        )
        .post(
            "/api/projects/*",
            authenticatedHandler(auth, async (request, user) => {
                const url = new URL(request.url);
                const match = url.pathname.match(PROJECT_PATH_RE);
                if (!match) return notFound();
                const id = match[1] ?? "";
                const sub = match[2];
                // `/api/projects/join/<token>`: `id` is the literal "join"
                // and the token rides in `sub`.
                if (id === "join")
                    return run(() => ({
                        body: { project: projects.join(user, sub ?? "") },
                    }));
                if (sub === "invites") {
                    const body = await readJson(request);
                    return run(() => {
                        const invite = projects.createInvite(
                            user,
                            id,
                            body?.role as InviteRole,
                            origin(request),
                        );
                        return { status: 201, body: { invite } };
                    });
                }
                if (sub === "tokens")
                    return run(() => ({
                        status: 201,
                        body: { token: projects.createToken(user, id) },
                    }));
                return notFound();
            }),
        )
        .patch(
            "/api/projects/*",
            authenticatedHandler(auth, async (request, user) => {
                const match = new URL(request.url).pathname.match(
                    PROJECT_PATH_RE,
                );
                if (!match) return notFound();
                const id = match[1] ?? "";
                const sub = match[2];
                const tail = match[3];
                if (!sub) {
                    const body = await readJson(request);
                    return run(() => ({
                        body: {
                            project: projects.rename(
                                user,
                                id,
                                body?.name,
                            ),
                        },
                    }));
                }
                if (sub === "members" && tail) {
                    const uid = Number(tail);
                    if (!Number.isInteger(uid) || uid < 1)
                        throw new ApiError("userId must be a positive integer");
                    const body = await readJson(request);
                    return run(() => {
                        projects.setMemberRole(
                            user,
                            id,
                            uid,
                            body?.role as InviteRole,
                        );
                        return { body: { ok: true } };
                    });
                }
                return notFound();
            }),
        )
        .delete(
            "/api/projects/*",
            authenticatedHandler(auth, (request, user) => {
                const match = new URL(request.url).pathname.match(
                    PROJECT_PATH_RE,
                );
                if (!match) return notFound();
                const id = match[1] ?? "";
                const sub = match[2];
                const tail = match[3];
                if (!sub)
                    return run(() => {
                        projects.remove(user, id);
                        return { body: { ok: true } };
                    });
                if (sub === "members" && tail) {
                    const uid = Number(tail);
                    if (!Number.isInteger(uid) || uid < 1)
                        return Response.json(
                            {
                                ok: false,
                                error: "userId must be a positive integer",
                                code: 400,
                            },
                            { status: 400 },
                        );
                    return run(() => {
                        projects.removeMember(user, id, uid);
                        return { body: { ok: true } };
                    });
                }
                if (sub === "invites" && tail)
                    return run(() => {
                        projects.revokeInvite(user, id, tail);
                        return { body: { ok: true } };
                    });
                if (sub === "tokens" && tail)
                    return run(() => {
                        projects.removeToken(user, id, tail);
                        return { body: { ok: true } };
                    });
                return notFound();
            }),
        );
}

const notFound = (): Response =>
    Response.json({ ok: false, error: "Not found", code: 404 }, { status: 404 });
