/*
 * Projects store (TODO/01-projects.md): users, memberships with roles
 * (owner / editor / viewer) and the single-use, expiring invite links that
 * grow a project beyond its owner.
 *
 * The store is the single authority on authorization: every method takes
 * the acting user and re-checks the role in the database, so a handler
 * cannot forget a guard. All mutations run in one SQLite transaction —
 * the (project_id, user_id) primary key plus the owner invariants make a
 * project always have exactly one owner.
 */
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "../../../../shared/params";
import { LOCAL_PROJECT_ID } from "../../../core/runtime";

export type ProjectRole = "owner" | "editor" | "viewer";
/** The roles an invite link can grant (never `owner`). */
export type InviteRole = "editor" | "viewer";

export interface ProjectSummary {
    id: string;
    name: string;
    /** The calling user's role in the project. */
    role: ProjectRole;
}

export interface ProjectMember {
    userId: number;
    login: string;
    role: ProjectRole;
}

/** A device token bound to a project — authenticates one device. */
export interface DeviceToken {
    id: number;
    /** The full token value — the only place it is ever returned. */
    token: string;
    createdAt: string;
}

export interface ProjectInvite {
    id: string;
    role: InviteRole;
    /** The full URL the link was created for (`<origin>/projects/join/<token>`). */
    url: string;
    createdAt: string;
    /** `null` = no expiry. */
    expiresAt: string | null;
    /** The login of the user who consumed the link, when used. */
    usedBy: string | null;
}

interface MemberRow {
    user_id: number;
    login: string;
    role: ProjectRole;
}

interface InviteRow {
    id: string;
    token: string;
    role: InviteRole;
    created_at: string;
    expires_at: string | null;
    used_by: string | null;
}

interface JoinInviteRow {
    id: string;
    project_id: string;
    role: InviteRole;
    expires_at: string | null;
    used_by: number | null;
    name: string;
}

const INVITE_ROLES: readonly InviteRole[] = ["editor", "viewer"];
/** An invite's default lifetime: 7 days. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NAME_MAX = 64;

/** No user database (`--no-auth` mode): projects do not exist there. */
function noDb(): never {
    throw new ApiError("Projects require account authentication", 503);
}

function parseName(raw: unknown): string {
    if (typeof raw !== "string") throw new ApiError("name is required");
    const name = raw.trim();
    if (name.length === 0 || name.length > NAME_MAX)
        throw new ApiError(`name must be 1-${NAME_MAX} characters`);
    return name;
}

/** `InviteRow` → API shape (the URL is rebuilt for the request's origin). */
function inviteOf(row: InviteRow, origin: string): ProjectInvite {
    return {
        id: row.id,
        role: row.role,
        url: `${origin}/projects/join/${row.token}`,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedBy: row.used_by,
    };
}

export interface Projects {
    /** Every project the user is a member of, newest first. */
    list(user: string): ProjectSummary[];
    /** The user's role in the project, `null` when not a member. */
    role(user: string, projectId: string): ProjectRole | null;
    /**
     * The user's role in the project, throwing `ApiError` (404 for a missing
     * project / non-member, 403 for an insufficient role). The guard entity
     * routes run (via `ProjectAccess`) before dispatching to a store.
     */
    requireRole(
        actor: string,
        projectId: string,
        allowed: readonly ProjectRole[],
    ): ProjectRole;
    /**
     * Ensure + return the user's auto-created "Personal" project id
     * (`personal-<user id>`, the id migration 0012 seeds). The user's home for
     * entities before they create named projects; idempotent.
     */
    personalProjectId(user: string): string;
    /** Create a project; the creator becomes its sole owner. `name` is validated. */
    create(user: string, name: unknown): ProjectSummary;
    /** Rename (owner / editor). `name` is validated. */
    rename(actor: string, projectId: string, name: unknown): ProjectSummary;
    /** Delete (owner); cascades to members and invites and device tokens. */
    remove(actor: string, projectId: string): void;
    /**
     * The project's device tokens, oldest first (any member). Each row carries
     * the full token value.
     */
    listTokens(actor: string, projectId: string): DeviceToken[];
    /**
     * Create a device token (owner/editor). Returns the row; `token` is the
     * value to present to the device.
     */
    createToken(actor: string, projectId: string): DeviceToken;
    /** Delete a device token (owner/editor); 404 for a missing or foreign id. */
    removeToken(actor: string, projectId: string, tokenId: string): void;
    /** The project's members, owner first, then join order (404 on a missing project). */
    members(projectId: string): ProjectMember[];
    /** Change a member's role (owner; the owner row is fixed). */
    setMemberRole(
        actor: string,
        projectId: string,
        targetUserId: number,
        role: InviteRole,
    ): void;
    /** Remove a member (owner; the owner row is protected). */
    removeMember(
        actor: string,
        projectId: string,
        targetUserId: number,
    ): void;
    /** Mint an invite link (owner / editor; at most the creator's role). */
    createInvite(
        actor: string,
        projectId: string,
        role: InviteRole,
        origin: string,
    ): ProjectInvite;
    /** The project's invite links, newest first (owner). */
    listInvites(
        actor: string,
        projectId: string,
        origin: string,
    ): ProjectInvite[];
    /** Revoke an invite link (owner). */
    revokeInvite(
        actor: string,
        projectId: string,
        inviteId: string,
    ): void;
    /** Preview the current project name without consuming a valid invite. */
    previewInvite(user: string, token: string): { name: string };
    /**
     * Accept an invite link: the user joins with the invite's role.
     * Fails for a missing, used or expired link and when the user is
     * already a member.
     */
    join(user: string, token: string): {
        id: string;
        name: string;
        role: InviteRole;
    };
}

export function createProjects(db: Database | null): Projects {
    /** The db, or the 503 throw in `--no-auth` mode (narrows `db` to non-null). */
    const useDb = (): Database => (db ? db : noDb());

    const userIdOf = (login: string): number => {
        const d = useDb();
        const row = d
            .prepare("SELECT id FROM users WHERE login = ?")
            .get(login) as { id: number } | undefined;
        if (!row) throw new ApiError(`Unknown user: ${login}`, 401);
        return row.id;
    };

    const roleRow = (
        userId: number,
        projectId: string,
    ): ProjectRole | null => {
        const d = useDb();
        const row = d
            .prepare(
                "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
            )
            .get(projectId, userId) as { role: ProjectRole } | undefined;
        return row?.role ?? null;
    };

    function validInvite(token: string): JoinInviteRow {
        const d = useDb();
        if (typeof token !== "string" || token === "")
            throw new ApiError("token is required");
        const row = d
            .prepare(
                "SELECT i.id, i.project_id, i.role, i.expires_at, i.used_by, " +
                    "p.name FROM project_invites i " +
                    "JOIN projects p ON p.id = i.project_id " +
                    "WHERE i.token = ?",
            )
            .get(token) as JoinInviteRow | undefined;
        if (!row) throw new ApiError("Invite link not found", 404);
        if (row.used_by !== null)
            throw new ApiError("Invite link already used", 409);
        if (row.expires_at && new Date(row.expires_at) < new Date())
            throw new ApiError("Invite link expired", 410);
        return row;
    }

    /**
     * The acting user's role in the project: a uniform 404 for both a
     * missing project and a non-member (no project existence leak), 403
     * when the role is insufficient.
     */
    function requireRole(
        actor: string,
        projectId: string,
        allowed: readonly ProjectRole[],
    ): ProjectRole {
        const role = roleRow(userIdOf(actor), projectId);
        if (!role)
            throw new ApiError(`Project ${projectId} not found`, 404);
        if (!allowed.includes(role))
            throw new ApiError(`Requires the ${allowed.join(" or ")} role`, 403);
        return role;
    }

    return {
        list: (user) => {
            if (!db) return [];
            const rows = db
                .prepare(
                    "SELECT p.id, p.name, m.role FROM projects p " +
                        "JOIN project_members m ON m.project_id = p.id " +
                        "WHERE m.user_id = (SELECT id FROM users WHERE login = ?) " +
                        "ORDER BY p.created_at DESC",
                )
                .all(user) as { id: string; name: string; role: ProjectRole }[];
            return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
        },

        role: (user, projectId) => {
            if (!db) return null;
            return roleRow(userIdOf(user), projectId);
        },

        requireRole: (actor, projectId, allowed) => requireRole(actor, projectId, allowed),

        personalProjectId: (user) => {
            // `--no-auth` has no user rows: the synthetic local project stands in.
            if (!db) return LOCAL_PROJECT_ID;
            const d = useDb();
            const uid = userIdOf(user);
            const projectId = `personal-${uid}`;
            d.transaction(() => {
                d.prepare(
                    "INSERT OR IGNORE INTO projects (id, name, owner_id, is_personal) " +
                        "VALUES (?, 'Personal', ?, 1)",
                ).run(projectId, uid);
                d.prepare(
                    "INSERT OR IGNORE INTO project_members (project_id, user_id, role) " +
                        "VALUES (?, ?, 'owner')",
                ).run(projectId, uid);
            })();
            return projectId;
        },

        create: (user, rawName) => {
            const d = useDb();
            const name = parseName(rawName);
            const id = randomUUID();
            const uid = userIdOf(user);
            d.transaction(() => {
                d.prepare(
                    "INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)",
                ).run(id, name, uid);
                d.prepare(
                    "INSERT INTO project_members (project_id, user_id, role) " +
                        "VALUES (?, ?, 'owner')",
                ).run(id, uid);
            })();
            return { id, name, role: "owner" };
        },

        rename: (actor, projectId, rawName) => {
            const d = useDb();
            const role = requireRole(actor, projectId, ["owner", "editor"]);
            const name = parseName(rawName);
            d.prepare(
                "UPDATE projects SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            ).run(name, projectId);
            return { id: projectId, name, role };
        },

        remove: (actor, projectId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner"]);
            d.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
        },

        listTokens: (actor, projectId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner", "editor", "viewer"]);
            const rows = d
                .prepare(
                    "SELECT id, token, created_at FROM tokens " +
                        "WHERE project_id = ? ORDER BY id ASC",
                )
                .all(projectId) as {
                    id: number;
                    token: string;
                    created_at: string;
                }[];
            return rows.map((r) => ({
                id: r.id,
                token: r.token,
                createdAt: r.created_at,
            }));
        },

        createToken: (actor, projectId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner", "editor"]);
            const token = randomBytes(24).toString("hex");
            const ins = d
                .prepare(
                    "INSERT INTO tokens (user_id, token, project_id) " +
                        "SELECT id, ?, ? FROM users WHERE login = ?",
                )
                .run(token, projectId, actor);
            const created = d
                .prepare(
                    "SELECT id, token, created_at FROM tokens WHERE id = ?",
                )
                .get(Number(ins.lastInsertRowid)) as {
                id: number;
                token: string;
                created_at: string;
            };
            return {
                id: created.id,
                token: created.token,
                createdAt: created.created_at,
            };
        },

        removeToken: (actor, projectId, tokenId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner", "editor"]);
            // Scope the delete to the project: a missing or foreign id 404s.
            const result = d
                .prepare(
                    "DELETE FROM tokens WHERE id = ? AND project_id = ?",
                )
                .run(tokenId, projectId);
            if (Number(result.changes) === 0)
                throw new ApiError(`Token ${tokenId} not found`, 404);
        },

        members: (projectId) => {
            const d = useDb();
            const project = d
                .prepare("SELECT id FROM projects WHERE id = ?")
                .get(projectId) as { id: string } | undefined;
            if (!project)
                throw new ApiError(`Project ${projectId} not found`, 404);
            const rows = d
                .prepare(
                    "SELECT m.user_id, u.login, m.role FROM project_members m " +
                        "JOIN users u ON u.id = m.user_id " +
                        "WHERE m.project_id = ? " +
                        "ORDER BY (m.role = 'owner') DESC, m.joined_at",
                )
                .all(projectId) as MemberRow[];
            return rows.map((r) => ({
                userId: r.user_id,
                login: r.login,
                role: r.role,
            }));
        },

        setMemberRole: (actor, projectId, targetUserId, role) => {
            const d = useDb();
            if (!INVITE_ROLES.includes(role))
                throw new ApiError("role must be editor or viewer");
            requireRole(actor, projectId, ["owner"]);
            const target = d
                .prepare(
                    "SELECT role FROM project_members " +
                        "WHERE project_id = ? AND user_id = ?",
                )
                .get(projectId, targetUserId) as
                | { role: ProjectRole }
                | undefined;
            if (!target) throw new ApiError("Member not found", 404);
            if (target.role === "owner")
                throw new ApiError("The owner role is fixed", 403);
            d.prepare(
                "UPDATE project_members SET role = ? " +
                    "WHERE project_id = ? AND user_id = ?",
            ).run(role, projectId, targetUserId);
        },

        removeMember: (actor, projectId, targetUserId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner"]);
            const target = d
                .prepare(
                    "SELECT role FROM project_members " +
                        "WHERE project_id = ? AND user_id = ?",
                )
                .get(projectId, targetUserId) as
                | { role: ProjectRole }
                | undefined;
            if (!target) throw new ApiError("Member not found", 404);
            if (target.role === "owner")
                throw new ApiError(
                    "The owner cannot be removed — transfer it first or delete the project",
                    403,
                );
            d.prepare(
                "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
            ).run(projectId, targetUserId);
        },

        createInvite: (actor, projectId, role, origin) => {
            const d = useDb();
            if (!INVITE_ROLES.includes(role))
                throw new ApiError("role must be editor or viewer");
            const actorRole = requireRole(actor, projectId, [
                "owner",
                "editor",
            ]);
            // The invite role must not exceed the creator's: an editor can
            // only mint viewer links.
            if (actorRole === "editor" && role !== "viewer")
                throw new ApiError(
                    "Editors can create viewer links only",
                    403,
                );
            const id = randomUUID();
            const token = randomBytes(24).toString("hex");
            const createdAt = new Date();
            const expiresAt = new Date(
                createdAt.getTime() + INVITE_TTL_MS,
            ).toISOString();
            d.prepare(
                "INSERT INTO project_invites " +
                    "(id, project_id, token, role, created_by, expires_at) " +
                    "VALUES (?, ?, ?, ?, ?, ?)",
            ).run(id, projectId, token, role, userIdOf(actor), expiresAt);
            return {
                id,
                role,
                url: `${origin}/projects/join/${token}`,
                createdAt: createdAt.toISOString(),
                expiresAt,
                usedBy: null,
            };
        },

        listInvites: (actor, projectId, origin) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner"]);
            const rows = d
                .prepare(
                    "SELECT i.id, i.token, i.role, i.created_at, i.expires_at, " +
                        "u.login AS used_by FROM project_invites i " +
                        "LEFT JOIN users u ON u.id = i.used_by " +
                        "WHERE i.project_id = ? ORDER BY i.created_at DESC",
                )
                .all(projectId) as InviteRow[];
            return rows.map((r) => inviteOf(r, origin));
        },

        revokeInvite: (actor, projectId, inviteId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner"]);
            const result = d
                .prepare(
                    "DELETE FROM project_invites WHERE project_id = ? AND id = ?",
                )
                .run(projectId, inviteId);
            if (Number(result.changes) === 0)
                throw new ApiError("Invite link not found", 404);
        },

        previewInvite: (user, token) => {
            userIdOf(user);
            return { name: validInvite(token).name };
        },

        join: (user, token) => {
            const d = useDb();
            const row = validInvite(token);
            const uid = userIdOf(user);
            if (roleRow(uid, row.project_id))
                throw new ApiError("You are already a member", 409);
            d.transaction(() => {
                d.prepare(
                    "INSERT INTO project_members (project_id, user_id, role) " +
                        "VALUES (?, ?, ?)",
                ).run(row.project_id, uid, row.role);
                d.prepare(
                    "UPDATE project_invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?",
                ).run(uid, row.id);
            })();
            return {
                id: row.project_id,
                name: row.name,
                role: row.role,
            };
        },
    };
}
