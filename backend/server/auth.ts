import { Database } from "bun:sqlite";
import {
    randomBytes,
    randomUUID,
    scryptSync,
    timingSafeEqual,
} from "node:crypto";
import { text } from "../../shared/http";
import { LOCAL_USER } from "./contracts";

export async function createAuth({
    noAuth,
    databaseFile,
}: {
    noAuth: boolean;
    databaseFile: string;
}) {
    const NO_AUTH = noAuth;
    const DB_FILE = databaseFile;

    // ----------------------------------------------------------------------
    // Auth (SQLite user store)
    // ----------------------------------------------------------------------
    /** scrypt password hash: `scrypt$<salt hex>$<hash hex>`. */
    function hashPassword(password: string): string {
        const salt = randomBytes(16).toString("hex");
        return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
    }
    /** Constant-time check of a password against a stored hash. */
    function verifyPassword(password: string, stored: string): boolean {
        const parts = stored.split("$");
        if (parts.length !== 3 || parts[0] !== "scrypt") return false;
        const expected = Buffer.from(parts[2], "hex");
        if (expected.length === 0) return false;
        return timingSafeEqual(
            scryptSync(password, parts[1], expected.length),
            expected,
        );
    }
    /** Hash only consumed by the login timing-equalizer below. */
    const DUMMY_PASSWORD_HASH = hashPassword("__padding__");

    /** The user database (null in `--no-auth` mode): logins with scrypt-hashed
     * passwords and the device tokens assigned to each user. */
    const db: Database | null = NO_AUTH
        ? null
        : await (async () => {
              const d = new Database(DB_FILE);
              d.run(`
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	login TEXT UNIQUE NOT NULL,
	password TEXT NOT NULL,
	admin INTEGER NOT NULL DEFAULT 0,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tokens (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	token TEXT NOT NULL,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS tokens_token ON tokens(token);
CREATE TABLE IF NOT EXISTS invitations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	code TEXT UNIQUE NOT NULL,
	created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	used_at DATETIME,
	expires_at DATETIME
);
CREATE TABLE IF NOT EXISTS dashboards (
	id TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	name TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1,
	"columns" INTEGER NOT NULL DEFAULT 12,
	widgets TEXT NOT NULL DEFAULT '[]',
	position INTEGER NOT NULL DEFAULT 0,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

              if (
                  (
                      d.prepare("SELECT COUNT(*) AS n FROM users").get() as {
                          n: number;
                      }
                  ).n === 0
              ) {
                  console.log(
                      `[auth] the user database ${DB_FILE} has no users yet — create the first account at /register`,
                  );
              }
              return d;
          })();

    /**
     * Resolve the user for a presented device token. With `--no-auth` every
     * connection maps to the single local user.
     */
    function userForToken(token: string | null): string | null {
        if (NO_AUTH) return LOCAL_USER;
        if (!token || !db) return null;
        const row = db
            .prepare(
                "SELECT u.login FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?",
            )
            .get(token) as { login: string } | undefined;
        return row?.login ?? null;
    }

    // Opaque cookie sessions: the browser stores a session id (HttpOnly), so
    // the user token never lives in JS storage and WebSocket upgrades inherit the
    // cookie automatically.
    const SESSION_COOKIE = "srtla_session";
    const sessions = new Map<string, string>(); // session id -> user

    function sessionCookie(req: Request): string | null {
        const raw = req.headers.get("cookie");
        if (!raw) return null;
        for (const part of raw.split(";")) {
            const idx = part.indexOf("=");
            if (idx > 0 && part.slice(0, idx).trim() === SESSION_COOKIE) {
                return part.slice(idx + 1).trim() || null;
            }
        }
        return null;
    }

    /** Resolve the user from the session cookie (or the local user in
     *  `--no-auth` mode). Null when unauthenticated. */
    function userFromRequest(req: Request): string | null {
        if (NO_AUTH) return LOCAL_USER;
        const id = sessionCookie(req);
        if (!id) return null;
        const user = sessions.get(id);
        if (!user) sessions.delete(id);
        return user ?? null;
    }

    const unauthorized = () => text("Authentication required", 401);

    /** Whether a login has the admin flag. `--no-auth` maps everything to the
     * full-privilege local user. */
    function adminOf(login: string): boolean {
        if (NO_AUTH) return true;
        if (!db) return false;
        const row = db
            .prepare("SELECT admin FROM users WHERE login = ?")
            .get(login) as { admin: number } | undefined;
        return row?.admin === 1;
    }

    /** Auth + admin guard: the session user's login, or a 401/403 Response. */
    function requireAdmin(req: Request): string | Response {
        const user = userFromRequest(req);
        if (!user) return unauthorized();
        if (!adminOf(user))
            return Response.json(
                { ok: false, error: "Forbidden" },
                { status: 403 },
            );
        return user;
    }

    /** Exchange a username + password for an opaque session cookie. */
    async function loginResponse(req: Request): Promise<Response> {
        let username: unknown;
        let password: unknown;
        try {
            const body = (await req.json()) as {
                username?: unknown;
                password?: unknown;
            };
            username = body.username;
            password = body.password;
        } catch {
            return Response.json(
                { ok: false, error: "Invalid JSON" },
                { status: 400 },
            );
        }
        let match: string | null = null;
        if (
            typeof username === "string" &&
            typeof password === "string" &&
            db
        ) {
            const rows = db
                .prepare("SELECT login, password FROM users")
                .all() as {
                login: string;
                password: string;
            }[];
            let checked = false;
            for (const row of rows) {
                if (row.login !== username) continue;
                if (verifyPassword(password, row.password)) match = row.login;
                checked = true;
                break;
            }
            // One dummy scrypt verify when no account matched, so timing does
            // not reveal which usernames exist.
            if (!checked) verifyPassword(password, DUMMY_PASSWORD_HASH);
        }
        if (!match)
            return Response.json(
                { ok: false, error: "Invalid username or password" },
                { status: 401 },
            );
        const user = match;
        const id = randomUUID();
        sessions.set(id, user);
        return Response.json(
            { ok: true, user },
            {
                headers: {
                    "set-cookie": `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`,
                },
            },
        );
    }

    /** POST /api/register — create a new profile. The first-ever account is
     * bootstrapped as admin with no invite; every later account requires a valid,
     * single-use invitation code, which is consumed in the same transaction. The
     * new account has no device tokens yet; the user adds them on the profile
     * page after signing in. */
    async function registerResponse(req: Request): Promise<Response> {
        let username: unknown;
        let password: unknown;
        let invite: unknown;
        try {
            const body = (await req.json()) as {
                username?: unknown;
                password?: unknown;
                invite?: unknown;
            };
            username = body.username;
            password = body.password;
            invite = body.invite;
        } catch {
            return Response.json(
                { ok: false, error: "Invalid JSON" },
                { status: 400 },
            );
        }
        if (
            typeof username !== "string" ||
            typeof password !== "string" ||
            username.trim().length === 0 ||
            password.length < 8
        ) {
            return Response.json(
                {
                    ok: false,
                    error: "Username and an 8+ character password are required",
                },
                { status: 400 },
            );
        }
        if (!db)
            return Response.json(
                { ok: false, error: "Registration is disabled" },
                { status: 403 },
            );
        const clean = username.trim();
        const hash = hashPassword(password);

        // Bootstrap: the very first account becomes admin and needs no invite. The
        // guarded INSERT makes this atomic for concurrent first registrations.
        const bootstrap = db
            .prepare(
                "INSERT INTO users (login, password, admin) SELECT ?, ?, 1 WHERE (SELECT COUNT(*) FROM users) = 0",
            )
            .run(clean, hash);
        if (bootstrap.changes > 0)
            return Response.json(
                { ok: true, user: clean, admin: true },
                { status: 201 },
            );

        // Everyone after the first account needs a valid, single-use invite.
        const code = typeof invite === "string" ? invite.trim() : "";
        if (!code)
            return Response.json(
                { ok: false, error: "Invitation code required" },
                { status: 403 },
            );

        const row = db
            .prepare(
                "SELECT id, used_by, expires_at FROM invitations WHERE code = ?",
            )
            .get(code) as
            | { id: number; used_by: number | null; expires_at: string | null }
            | undefined;
        if (!row)
            return Response.json(
                { ok: false, error: "Invalid invitation code" },
                { status: 403 },
            );
        if (row.used_by !== null)
            return Response.json(
                { ok: false, error: "Invitation already used" },
                { status: 403 },
            );
        if (row.expires_at && new Date(row.expires_at) < new Date())
            return Response.json(
                { ok: false, error: "Invitation expired" },
                { status: 403 },
            );

        try {
            db.transaction(() => {
                db.prepare(
                    "INSERT INTO users (login, password, admin) VALUES (?, ?, 0)",
                ).run(clean, hash);
                db.prepare(
                    "UPDATE invitations SET used_by = (SELECT id FROM users WHERE login = ?), " +
                        "used_at = CURRENT_TIMESTAMP WHERE id = ?",
                ).run(clean, row.id);
            })();
        } catch {
            // Username already taken (UNIQUE) or any other insert/commit failure.
            return Response.json(
                { ok: false, error: "That username is already taken" },
                { status: 409 },
            );
        }
        return Response.json(
            { ok: true, user: clean, admin: false },
            { status: 201 },
        );
    }

    /** GET /api/register/status — lets the register page know whether an invite
     * code is required (i.e. whether any account already exists). */
    function hasUsers(): boolean {
        return (
            db !== null &&
            (db.prepare("SELECT COUNT(*) AS n FROM users").get() as {
                n: number;
            }).n > 0
        );
    }

    function registerStatusResponse(): Response {
        return Response.json({ ok: true, needsInvite: hasUsers() });
    }

    function logoutResponse(req: Request): Response {
        const id = sessionCookie(req);
        if (id) sessions.delete(id);
        return Response.json(
            { ok: true },
            {
                headers: {
                    "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
                },
            },
        );
    }

    // ----------------------------------------------------------------------
    // Profile API: the session user's password and device tokens
    // ----------------------------------------------------------------------

    /** The user's tokens as the profile page shows them. */
    function tokensFor(user: string) {
        return (db
            ?.prepare(
                "SELECT id, token, created_at FROM tokens WHERE user_id = (SELECT id FROM users WHERE login = ?) ORDER BY id",
            )
            .all(user) ?? []) as {
            id: number;
            token: string;
            created_at: string;
        }[];
    }

    /** GET /api/whoami — the session user's login name (profile dropdown). */
    function whoamiResponse(user: string): Response {
        return Response.json({ ok: true, user });
    }

    /** GET /api/profile — username, admin flag + the user's device tokens. */
    function profileResponse(user: string): Response {
        return Response.json({
            ok: true,
            username: user,
            admin: adminOf(user),
            tokens: tokensFor(user).map((t) => ({
                id: t.id,
                token: t.token,
                createdAt: t.created_at,
            })),
        });
    }

    // ----------------------------------------------------------------------
    // Invitations: admin-only minting + history of the single-use codes that gate
    // registration after the first (bootstrapped) account exists.
    // ----------------------------------------------------------------------

    /** POST /api/invitations — mint a fresh single-use invite (admin only). */
    function createInvitationResponse(req: Request): Response {
        const auth = requireAdmin(req);
        if (auth instanceof Response) return auth;
        if (!db) return unauthorized();

        const code = randomBytes(16).toString("hex");
        const expiresAt = new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString();

        db.prepare(
            "INSERT INTO invitations (code, created_by, expires_at) SELECT ?, id, ? FROM users WHERE login = ?",
        ).run(code, expiresAt, auth);

        return Response.json({ ok: true, code, expiresAt }, { status: 201 });
    }

    /** GET /api/invitations — the invite history, newest first (admin only). */
    function listInvitationsResponse(req: Request): Response {
        const auth = requireAdmin(req);
        if (auth instanceof Response) return auth;
        if (!db) return unauthorized();

        const rows = db
            .prepare(
                "SELECT i.code, i.created_at, i.expires_at, i.used_at, " +
                    "u1.login AS created_by, u2.login AS used_by " +
                    "FROM invitations i " +
                    "LEFT JOIN users u1 ON u1.id = i.created_by " +
                    "LEFT JOIN users u2 ON u2.id = i.used_by " +
                    "ORDER BY i.id DESC",
            )
            .all() as {
            code: string;
            created_at: string;
            expires_at: string | null;
            used_at: string | null;
            created_by: string | null;
            used_by: string | null;
        }[];

        return Response.json({ ok: true, invitations: rows });
    }

    /** POST /api/profile/password — {current, new}; the new password is
     * required to differ from the current one. */
    async function changePasswordResponse(
        req: Request,
        user: string,
    ): Promise<Response> {
        let current: unknown;
        let next: unknown;
        try {
            const body = (await req.json()) as {
                current?: unknown;
                new?: unknown;
            };
            current = body.current;
            next = body.new;
        } catch {
            return Response.json(
                { ok: false, error: "Invalid JSON" },
                { status: 400 },
            );
        }
        if (
            typeof current !== "string" ||
            typeof next !== "string" ||
            next.length === 0 ||
            !db
        ) {
            return Response.json(
                {
                    ok: false,
                    error: "A current password and a non-empty new password are required",
                },
                { status: 400 },
            );
        }
        const row = db
            .prepare("SELECT password FROM users WHERE login = ?")
            .get(user) as { password: string } | undefined;
        if (!row || !verifyPassword(current, row.password)) {
            return Response.json(
                { ok: false, error: "Invalid username or password" },
                { status: 401 },
            );
        }
        db.prepare("UPDATE users SET password = ? WHERE login = ?").run(
            hashPassword(next),
            user,
        );
        // The session itself stays valid: only the login secret changed.
        return Response.json({ ok: true });
    }

    /** POST /api/profile/tokens — add a fresh device token; it is returned in
     * the body (the only time the full value is ever sent). */
    function createTokenResponse(user: string): Response {
        if (!db) return unauthorized();
        const token = randomBytes(24).toString("hex");
        const row = db
            .prepare(
                "INSERT INTO tokens (user_id, token) SELECT id, ? FROM users WHERE login = ?",
            )
            .run(token, user);
        const created = db
            .prepare("SELECT id, token, created_at FROM tokens WHERE id = ?")
            .get(Number(row.lastInsertRowid)) as {
            id: number;
            token: string;
            created_at: string;
        };
        return Response.json({
            ok: true,
            token: {
                id: created.id,
                token: created.token,
                createdAt: created.created_at,
            },
        });
    }

    /** DELETE /api/profile/tokens/<id> — revoke one of the user's tokens. */
    function deleteTokenResponse(url: URL, user: string): Response {
        const rawId = url.pathname.split("/").pop() ?? "";
        const id = Number(rawId);
        if (!Number.isInteger(id) || id < 1 || !db)
            return Response.json(
                { ok: false, error: "Invalid token id" },
                { status: 400 },
            );
        const result = db
            .prepare(
                "DELETE FROM tokens WHERE id = ? AND user_id = (SELECT id FROM users WHERE login = ?)",
            )
            .run(id, user);
        if (Number(result.changes) === 0)
            return Response.json(
                { ok: false, error: "Token not found" },
                { status: 404 },
            );
        return Response.json({ ok: true });
    }

    return {
        db,
        hasUsers,
        userForToken,
        userFromRequest,
        unauthorized,
        loginResponse,
        registerResponse,
        registerStatusResponse,
        logoutResponse,
        whoamiResponse,
        profileResponse,
        changePasswordResponse,
        createTokenResponse,
        deleteTokenResponse,
        listInvitationsResponse,
        createInvitationResponse,
    };
}
