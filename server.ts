#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import {
    randomBytes,
    randomUUID,
    scryptSync,
    timingSafeEqual,
} from "node:crypto";
/*
 * SRTLA control server.
 *
 * Devices (relay, encoder, or combined encoder+relay) connect out to this server (`client.ts --remote ws(s)://host:port/device`)
 * and operators control them from a browser, using the relay's own web UI
 * (../public) served per device.
 *
 * Endpoints:
 *   GET  /                 device list (public/devices.html)
 *   GET  /d/<id>/          device UI (public/index.html); the setup wizard
 *                          (public/setup.html) while the device has no config
 *                          file (status.setupRequired; ?ui=1 forces the UI)
 *   GET  /d/<id>/settings/ device settings (public/settings.html)
 *   GET  /d/<id>/setup/    setup wizard for one device
 *   WS   /d/<id>/ws        browser ⇄ device; same protocol as the relay's local /ws
 *   GET  /api/devices      JSON list of known devices
 *   GET  /dashboards/      server dashboards: compose dashboards from the modules
 *                          of connected devices (public/dashboards.html)
 *   GET  /dashboards/view/<id>/  /edit/<id>/  dashboard grid; edit starts in
 *                          edit mode (public/dashboardview.html)
 *   GET  /dashboards/add/<id>/   dedicated "add widget" page (public/dashboardadd.html)
 *   GET  /api/dashboards   JSON list of dashboards
 *   POST /api/dashboards   create a dashboard {name, widgets}
 *   PUT  /api/dashboards/<id>   replace a dashboard {name, widgets}
 *   DEL  /api/dashboards/<id>   remove a dashboard
 *   GET  /register       create an account (public/register.html)
 *   GET  /api/register/status  does registration require an invite? {needsInvite}
 *   POST /api/register   create a profile {username, password, invite} → 201
 *                         (the first account bootstraps as admin with no invite;
 *                          later accounts need a single-use invite, 403/409)
 *   GET  /profile/       user profile (password change + device tokens, and the
 *                        invitations panel for admins)
 *   GET  /api/whoami     the session user's login name
 *   GET  /api/profile    username, admin flag + the user's device tokens
 *   POST /api/profile/password  change the login password {current, new}
 *   POST /api/profile/tokens    add a device token; returns it in the body
 *   DEL  /api/profile/tokens/<id>  remove a device token
 *   GET  /api/invitations  invite history (admin only)
 *   POST /api/invitations  mint a fresh single-use invite (admin only)
 *   WS   /device           device connections (Authorization: Bearer <token>, x-device-id: <id>,
 *                          x-device-role: relay|encoder|combined)
 *   WS   /dashboards/ws    the shared live feed: widget data (kick.stats /
 *                          kick.chat / tiktok.chat / twitch.chat / youtube.chat
 *                          events, widget.snapshot on connect) for the channel
 *                          chat widgets (the server follows each widget
 *                          channel), plus the live device list (devices.snapshot
 *                          on connect, devices.changed whenever any device's
 *                          state/telemetry/parameters change) and the dashboard
 *                          list (dashboards.snapshot on connect; the
 *                          dashboards.changed broadcasts above)
 *   GET  /healthz          liveness (no auth)
 *
 * Devices are keyed by a stable UUID (hostnames change); the per-device
 * parameters (hostname, color, role) the server keeps for each uuid arrive in
 * the device's hello frame:
 *   { "type": "hello", "id": "<uuid>", "role": …, "hostname": …, "color": … }
 *
 * Browser requests `{id, method, params}` are forwarded to the device with a
 * server-unique id; responses are routed back with the browser's id restored.
 * Device `event` frames (status, srtla.stats, …) fan out to all viewers of that
 * device; the last status and link stats are cached and replayed to new viewers. Viewers also receive
 * `{type:"event", event:"device", data:{id, online, hostname, color, …}}` on
 * connect and whenever the device connects or disconnects.
 * The device's event log (`log` events) is cached too, merged with this server's own
 * "Device online / offline" entries (in memory only), and replayed to new viewers as a reset.
 * Entries are memory-only: a device with no heartbeat for 5 minutes is removed from the
 * list and reappears from scratch the next time it connects.
 *
 * Auth:
 *   users    Users live in a SQLite database (--db, default users.db) with
 *            scrypt-hashed passwords; each user owns the device tokens stored
 *            for them. Devices present one of their user's tokens
 *            (Authorization: Bearer) on connect and are assigned to that
 *            user; the browser signs in at /login with the username and
 *            password and receives an opaque HttpOnly session cookie. New
 *            accounts can be created at /register (self-service). Each user
 *            only sees (and may create) their own devices and dashboards, and
 *            manages their password and tokens on /profile/.
 *   --no-auth disables auth (local testing only; everything maps to "local").
 *
 * Dashboards are a per-user feature: the dashboards page composes them from the
 * modules of the user's devices and persists them to the SQLite database
 * (the `dashboards` table of --db).
 *
 * Usage:
 *   bun server.ts --port 8090
 */
import type { ServerWebSocket } from "bun";
import type {
    DeviceInfo,
    DeviceSummary,
    ServerDashboard,
    ServerDashboardWidget,
    SrtlaStats,
    SrtlaStatsEvent,
    Status,
    WidgetType,
} from "./public/types";
import { configFieldName } from "./public/types";
import { arg, flag, intArg } from "./src/args";
import {
    i18nResponse,
    imageResponse,
    notFound,
    originAllowed,
    text,
    upgradeRequired,
} from "./src/http";
import {
    catalog,
    i18nReady,
    isLanguage,
    type Language,
    translate,
} from "./src/i18n";
import {
    LOG_MAX,
    type LogEntry,
    type LogEvent,
    type LogLevel,
} from "./src/logMessages";
import {
    initWidgetHub,
    syncWidgetHub,
    widgetConfigFields,
    widgetHubSnapshot,
} from "./src/registry";
import { parseJsonObject, textOf } from "./src/util";
import { COLOR_RE, isRole, type Role } from "./src/validate";

const PORT = intArg("--port", 8090, 1, 65535);
const HOST = arg("--host", "0.0.0.0");

const NO_AUTH = flag("--no-auth");
// SQLite database: user logins (hashed passwords), their device tokens and
// the per-user dashboards
const DB_FILE = arg("--db", process.env.SRTLA_DB ?? "users.db");

const STALE_DEVICE_MS = 5 * 60 * 1000;
const PRUNE_INTERVAL_MS = 30 * 1000;
// A flapping device link loses forwarded requests; fail before the client's
// 30 s timeout so the page surfaces the error and retries promptly.
const REQUEST_TIMEOUT_MS = 20_000;

const ID_RE = /^[\w.-]{1,64}$/;
// /d/<id>, /d/<id>/, /d/<id>/ws, /d/<id>/settings[/], /d/<id>/setup[/]
const DEVICE_PATH_RE = /^\/d\/([^/]+)(?:(\/)(?:(ws)|(settings|setup)(\/)?)?)?$/;
// /d/<id>/pipelines/new/ and /d/<id>/pipelines/edit/<encoded-id>/ — the
// dedicated pipeline editor page (the id is %-encoded, slashes included).
const PIPELINE_EDIT_RE = /^\/d\/([^/]+)\/pipelines\/(new|edit\/[^/]+)\/?$/;
const WIDGET_TYPES: WidgetType[] = [
    "obs",
    "relay",
    "encoder",
    "combined",
    "stats",
    "chat",
];
const DASH_PATH_RE = /^\/api\/dashboards(?:\/([\w.-]{1,64}))?$/;
const viewersTopic = (id: string) => `viewers:${id}`;
// Per-user broadcast topics (device lists / dashboard list changes are
// scoped to the owning user, not global).
const dashboardsTopic = (user: string) => `dashboards:${user}`;
const devicesTopic = (user: string) => `devices:${user}`;
// The widget hub is device state, shared across the user's dashboards.
const WIDGET_HUB_TOPIC = "widgets:hub";
const LOCAL_USER = "local";
const INDEPENDENT_WIDGETS: ReadonlySet<WidgetType> = new Set([
    "stats",
    "chat",
]);
const DASH_COLUMNS = 12;
/** Default `{w, h}` per widget type — seeds new widgets and unknown stored rows. */
const WIDGET_SIZE: Record<WidgetType, { w: number; h: number }> = {
    obs: { w: 6, h: 6 },
    relay: { w: 4, h: 4 },
    encoder: { w: 6, h: 5 },
    combined: { w: 6, h: 10 },
    stats: { w: 3, h: 3 },
    chat: { w: 3, h: 8 },
};

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

// Opaque cookie sessions: the browser stores a session id (HttpOnly), so the
// user token never lives in JS storage and WebSocket upgrades inherit the
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
    if (typeof username === "string" && typeof password === "string" && db) {
        const rows = db.prepare("SELECT login, password FROM users").all() as {
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
        (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number })
            .n > 0
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
        const body = (await req.json()) as { current?: unknown; new?: unknown };
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

// ----------------------------------------------------------------------
// Frontend (bundled once at startup so it can sit behind auth)
// ----------------------------------------------------------------------
const PAGES = [
    "login",
    "register",
    "devices",
    "profile",
    "index",
    "settings",
    "setup",
    "dashboards",
    "dashboardview",
    "dashboardadd",
    "pipelineedit",
] as const;
type PageName = (typeof PAGES)[number];
const pages = {} as Record<PageName, string>;
const assets = new Map<string, Blob>();
{
    // One build for all pages: shared code (mithril, UI components) lands in common chunks.
    // Regenerate the frontend module manifest (REFACTOR-modules.md §4.1) so any
    // new modules/<id>/frontend.tsx is in the bundle before we build it
    // (npm pre hooks don't run for `bun server.ts`).
    await Bun.$`bun scripts/gen-modules.ts`.quiet();
    const result = await Bun.build({
        entrypoints: PAGES.map(
            (name) =>
                new URL(`./public/${name}.html`, import.meta.url).pathname,
        ),
        target: "browser",
        minify: true,
        splitting: true,
        publicPath: "/assets/",
        naming: {
            asset: "[name]-[hash].[ext]",
            chunk: "[name]-[hash].[ext]",
            entry: "[name]-[hash].[ext]",
        },
    });
    if (!result.success) {
        for (const l of result.logs) console.error(l);
        throw new Error("Failed to bundle the web UI");
    }
    for (const out of result.outputs) {
        const file = out.path.replace(/^\.\//, "");
        const page = PAGES.find(
            (name) => file.startsWith(`${name}-`) && file.endsWith(".html"),
        );
        if (page) pages[page] = await out.text();
        else assets.set(file, out);
    }
}

// Log strings (t()/translate) are only served from request handlers, but make
// sure the i18next catalogs are loaded before the server accepts any request.
await i18nReady;

const htmlResponse = (page: PageName) =>
    new Response(pages[page], {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
        },
    });

// ----------------------------------------------------------------------
// Device registry and request routing
// ----------------------------------------------------------------------
type WsData =
    | {
          kind: "device";
          id: string;
          address: string;
          owner: string;
          role?: Role;
      }
    | { kind: "viewer"; id: string; user: string }
    | { kind: "dashboards"; user: string };
type Socket = ServerWebSocket<WsData>;

interface Device {
    /** Stable uuid; the key of this entry. Hostnames change, so the id does not */
    id: string;
    /** User this device is assigned to (derived from the connect token) */
    owner?: string;
    hostname?: string; // display name, from the device's hello
    color?: string; // the device's header color, from the device's hello
    language?: Language; // UI language, from the device's hello
    role?: Role; // device type, from the upgrade header / hello / status
    version?: string; // app build stamp, from the device's hello (absent on pre-version builds)
    ws: Socket | null;
    address?: string;
    connectedAt?: number;
    lastSeen?: number;
    statusMsg?: string; // last serialized status event, replayed to new viewers
    statsMsg?: string; // last srtla.stats event, likewise
    stats?: SrtlaStats | null;
    status?: Status;
    statusAt?: number;
    log: LogEntry[]; // the device's own event log, as last pushed
    serverLog: LogEntry[]; // online / offline entries added here
}

interface Pending {
    deviceId: string;
    viewer: Socket;
    clientId: unknown;
    method: string;
    timer: ReturnType<typeof setTimeout>;
}

const devices = new Map<string, Device>();
const newDevice = (id: string): Device => ({
    id,
    ws: null,
    log: [],
    serverLog: [],
});
const pending = new Map<number, Pending>();
let nextRequestId = 1;
let nextServerLogId = 1;

const deviceFor = (id: string): Device => {
    let d = devices.get(id);
    if (!d) devices.set(id, (d = newDevice(id)));
    return d;
};

const deviceInfo = (d: Device): DeviceInfo => ({
    id: d.id,
    hostname: d.hostname,
    color: d.color,
    language: d.language,
    role: d.role,
    version: d.version,
    online: d.ws !== null,
    connectedAt: d.connectedAt,
    lastSeen: d.lastSeen,
    address: d.address,
});

const event = (name: string, data: unknown) =>
    JSON.stringify({ type: "event", event: name, data });
const deviceEvent = (d: Device) => event("device", deviceInfo(d));
const logEvent = (data: LogEvent) => event("log", data);
const publish = (d: Device, msg: string) =>
    server.publish(viewersTopic(d.id), msg);

const logHistory = (d: Device) =>
    logEvent({
        reset: true,
        entries: [...d.log, ...d.serverLog]
            .sort((a, b) => a.at - b.at)
            .slice(-LOG_MAX),
    });

/** Keep the newest LOG_MAX entries. */
const trimLog = (log: LogEntry[]) =>
    log.splice(0, Math.max(0, log.length - LOG_MAX));

function addServerLog(d: Device, level: LogLevel, message: string): void {
    const entry: LogEntry = {
        id: nextServerLogId++,
        origin: "server",
        at: Date.now(),
        level,
        section: "Device",
        message,
    };
    d.serverLog.push(entry);
    trimLog(d.serverLog);
    publish(d, logEvent({ entries: [entry] }));
}

/** Apply a device `log` event to the cache; returns the message to forward to viewers. */
function updateDeviceLog(
    d: Device,
    data: LogEvent | undefined,
    raw: string,
): string | null {
    if (!data || !Array.isArray(data.entries)) return null;
    if (data.reset) {
        d.log = data.entries.slice(-LOG_MAX);
        return logHistory(d);
    }
    for (const e of data.entries) {
        const i = d.log.findIndex((x) => x.id === e.id);
        if (i >= 0) d.log[i] = e;
        else d.log.push(e);
    }
    trimLog(d.log);
    return raw;
}

const errorResponse = (
    id: unknown,
    method: string,
    error: string,
    code: number,
) => JSON.stringify({ type: "response", id, method, ok: false, error, code });

function sendToViewer(viewer: Socket, msg: string): void {
    if (viewer.readyState === WebSocket.OPEN) viewer.send(msg);
}

function failPending(
    predicate: (p: Pending) => boolean,
    error: string,
    code: number,
    notify = true,
): void {
    for (const [sid, p] of pending) {
        if (!predicate(p)) continue;
        clearTimeout(p.timer);
        pending.delete(sid);
        if (notify)
            sendToViewer(
                p.viewer,
                errorResponse(p.clientId, p.method, error, code),
            );
    }
}

function forwardRequest(
    device: Device,
    deviceSocket: Socket,
    viewer: Socket,
    clientId: unknown,
    method: string,
    params: unknown,
): void {
    const sid = nextRequestId++;
    const timer = setTimeout(() => {
        pending.delete(sid);
        sendToViewer(
            viewer,
            errorResponse(clientId, method, "device did not respond", 504),
        );
    }, REQUEST_TIMEOUT_MS);
    pending.set(sid, {
        deviceId: device.id,
        viewer,
        clientId,
        method,
        timer,
    });
    deviceSocket.send(JSON.stringify({ id: sid, method, params }));
}

/** Apply the device's self-reported parameters (hello / status); returns whether any changed. */
function updateDevice(
    d: Device,
    fields: Partial<
        Pick<Device, "role" | "hostname" | "color" | "language" | "version">
    >,
): boolean {
    let changed = false;
    for (const [key, value] of Object.entries(fields) as [
        keyof typeof fields,
        string | undefined,
    ][]) {
        if (value === undefined || d[key] === value) continue;
        (d as unknown as Record<string, string>)[key] = value;
        changed = true;
    }
    return changed;
}

function onDeviceMessage(d: Device, raw: string | Buffer): void {
    d.lastSeen = Date.now();
    const text = textOf(raw);
    const msg = parseJsonObject(text);
    if (!msg) return;

    if (msg.type === "response" && typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p || p.deviceId !== d.id) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        sendToViewer(p.viewer, JSON.stringify({ ...msg, id: p.clientId }));
        return;
    }

    if (msg.type === "request") {
        onDeviceRequest(d, msg);
        return;
    }

    if (msg.type === "event") {
        if (msg.event === "status") {
            d.statusMsg = text;
            d.status = msg.data as Status;
            d.statusAt = Date.now();
            const role = d.status?.role;
            // A role change is structural — refresh the list at once for it
            if (updateDevice(d, { role: isRole(role) ? role : undefined })) {
                publish(d, deviceEvent(d));
                publishDeviceList(true);
                return;
            }
            publishDeviceList();
        } else if (msg.event === "srtla.stats") {
            d.statsMsg = text;
            d.stats = (msg.data as SrtlaStatsEvent | undefined)?.stats ?? null;
            publishDeviceList();
        } else if (msg.event === "log") {
            const forward = updateDeviceLog(
                d,
                msg.data as LogEvent | undefined,
                text,
            );
            if (forward) publish(d, forward);
            return;
        }
        publish(d, text);
        return;
    }

    if (msg.type === "hello") {
        if (msg.id !== d.id)
            console.warn(
                `[device ${d.id}] hello announced a different id (${String(msg.id)}) — ignored`,
            );
        // The per-uuid parameters the device reports about itself; a color change
        // re-themes the list dot, a hostname change the display name
        const changed = updateDevice(d, {
            role: isRole(msg.role) ? msg.role : undefined,
            hostname:
                typeof msg.hostname === "string" && msg.hostname !== ""
                    ? msg.hostname
                    : undefined,
            color:
                typeof msg.color === "string" && COLOR_RE.test(msg.color)
                    ? msg.color
                    : undefined,
            language: isLanguage(msg.language) ? msg.language : undefined,
            // Absent on builds that predate version reporting — stays undefined, which the UI flags as "old app"
            version:
                typeof msg.version === "string" && msg.version !== ""
                    ? msg.version
                    : undefined,
        });
        if (changed) {
            publish(d, deviceEvent(d));
            publishDeviceList(true);
        }
    }
}

/** Device-initiated request: `devices.list` is answered by the server itself
 * (the registry); anything else with a `target` is forwarded to that device
 * like a viewer request, and the response travels back over the origin's socket. */
function onDeviceRequest(origin: Device, msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id !== "number") return;
    const method = typeof msg.method === "string" ? msg.method : "";
    if (!method) return;
    const respond = (payload: string): void => {
        const ws = origin.ws;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
    };

    if (method === "devices.list") {
        // Devices only see their own user's assignments
        respond(
            JSON.stringify({
                type: "response",
                id,
                method,
                ok: true,
                result: summaries(origin.owner ?? LOCAL_USER),
            }),
        );
        return;
    }

    const targetId = typeof msg.target === "string" ? msg.target : "";
    const target = targetId ? devices.get(targetId) : undefined;
    if (!target?.ws) {
        respond(errorResponse(id, method, "device offline", 503));
        return;
    }

    const originWs = origin.ws;
    if (!originWs) {
        respond(errorResponse(id, method, "device offline", 503));
        return;
    }
    const params =
        msg.params &&
        typeof msg.params === "object" &&
        !Array.isArray(msg.params)
            ? msg.params
            : {};
    forwardRequest(target, target.ws, originWs, id, method, params);
}

function onViewerMessage(
    ws: Socket,
    deviceId: string,
    _user: string,
    raw: string | Buffer,
): void {
    const msg = parseJsonObject(textOf(raw));
    if (!msg) {
        ws.send(errorResponse(null, "", "Invalid JSON object", 400));
        return;
    }
    const clientId = msg.id ?? null;
    const method = typeof msg.method === "string" ? msg.method : "";
    if (!method) {
        ws.send(errorResponse(clientId, method, "method is required", 400));
        return;
    }
    const d = devices.get(deviceId);
    if (!d?.ws) {
        ws.send(errorResponse(clientId, method, "device offline", 503));
        return;
    }

    forwardRequest(d, d.ws, ws, clientId, method, msg.params);
}

// ----------------------------------------------------------------------
// Server dashboards: composed from the modules of connected devices, persisted
// to the `dashboards` table of the SQLite database (one row per dashboard,
// widgets stored as a JSON array).
// ----------------------------------------------------------------------
interface DashboardRow {
    id: string;
    owner: string;
    name: string;
    version: number;
    columns: number;
    widgets: string;
    position: number;
}

/** Read `{x, y, w, h}` from an inbound widget payload (missing fields fall back to the type default). */
function parseGrid(
    item: Record<string, unknown>,
    type: WidgetType,
): { x: number; y: number; w: number; h: number } {
    const size = WIDGET_SIZE[type];
    const toInt = (v: unknown, fallback: number, name: string) => {
        const n = v === undefined ? fallback : Number(v);
        if (!Number.isInteger(n))
            throw new ApiError(`${name} must be an integer`);
        return n;
    };
    const w = toInt(item.w, size.w, "w");
    const x = toInt(item.x, 0, "x");
    const y = toInt(item.y, 0, "y");
    const h = toInt(item.h, size.h, "h");
    if (x < 0 || y < 0 || w < 1 || h < 1)
        throw new ApiError("Widget position/size must be positive");
    if (x + w > DASH_COLUMNS)
        throw new ApiError("Widget extends past the grid");
    return { x, y, w, h };
}

function parseWidgets(raw: unknown, owner: string): ServerDashboardWidget[] {
    if (!Array.isArray(raw)) throw new ApiError("widgets is required");
    return raw.map((w) => {
        const item = (w && typeof w === "object" ? w : {}) as Record<
            string,
            unknown
        >;
        const type = item.type;
        if (
            typeof type !== "string" ||
            !WIDGET_TYPES.includes(type as WidgetType)
        ) {
            throw new ApiError(`Unknown widget type: ${String(type)}`);
        }
        const independent = INDEPENDENT_WIDGETS.has(type as WidgetType);
        const deviceId = item.deviceId;
        if (deviceId !== undefined && typeof deviceId !== "string") {
            throw new ApiError("Widget deviceId must be a string");
        }
        const grid = parseGrid(item, type as WidgetType);
        const visible = item.visible === true;
        const name =
            typeof item.name === "string" && item.name ? item.name : type;
        // Preserve a client-assigned id so new widgets keep stable gridstack
        // identity; assign one otherwise.
        const id =
            typeof item.id === "string" && item.id ? item.id : randomUUID();
        if (independent) {
            // Channel widgets are device-independent: they carry their own data
            // source parameters, declared by the widget module (the dashboard
            // API owns their hub). Values may be missing/empty — a new widget
            // is added first and its config filled in via the widget editor.
            const cfg = (
                item.config && typeof item.config === "object"
                    ? item.config
                    : {}
            ) as Record<string, unknown>;
            const fields = widgetConfigFields(type);
            const fieldNames = fields.map(configFieldName);
            const config: Record<string, string> = {};
            for (const name of fieldNames) {
                const v = cfg[name];
                if (v !== undefined) {
                    if (typeof v !== "string")
                        throw new ApiError(`config.${name} must be a string`);
                    config[name] = v.trim();
                } else config[name] = "";
            }
            for (const key of Object.keys(cfg)) {
                if (!fieldNames.includes(key))
                    throw new ApiError(`Unknown config field: ${key}`);
            }
            return {
                id,
                deviceId: typeof deviceId === "string" ? deviceId : "",
                type: type as WidgetType,
                name,
                ...grid,
                visible,
                config,
            };
        }
        if (typeof deviceId !== "string" || deviceId === "")
            throw new ApiError("Widget needs a deviceId");
        // A widget may only bind to a device assigned to the dashboard's owner
        const bound = devices.get(deviceId);
        if (!bound || (bound.owner ?? LOCAL_USER) !== owner)
            throw new ApiError(`Device not available: ${deviceId}`);
        if (item.config !== undefined)
            throw new ApiError("Only channel widgets accept a config");
        return {
            id,
            deviceId,
            type: type as WidgetType,
            name,
            ...grid,
            visible,
        };
    });
}

let dashboards: ServerDashboard[] = [];

/** The in-memory dashboards reloaded from the database, in stored order. */
function loadDashboards(): ServerDashboard[] {
    if (!db) return [];
    const rows = db
        .prepare("SELECT * FROM dashboards ORDER BY position")
        .all() as DashboardRow[];
    return rows.map((row) => {
        let widgets: ServerDashboardWidget[] = [];
        try {
            widgets = JSON.parse(row.widgets) as ServerDashboardWidget[];
        } catch {
            // Corrupt row: keep the dashboard shell, drop its widgets
            console.warn(
                `[dashboards] ${row.id}: dropping widgets — the stored JSON is unparsable`,
            );
        }
        return {
            id: row.id,
            owner: row.owner,
            name: row.name,
            version: row.version,
            widgets,
            columns: row.columns,
        };
    });
}

/** Persist the whole in-memory list (dashboards are small; a full rewrite in
 * one transaction is simplest and always leaves the table consistent). */
function saveDashboards(): void {
    if (!db) return;
    try {
        db.transaction(() => {
            db.prepare("DELETE FROM dashboards").run();
            const ins = db.prepare(
                'INSERT INTO dashboards (id, owner, name, version, "columns", widgets, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
            );
            dashboards.forEach((d, i) =>
                ins.run(
                    d.id,
                    d.owner ?? LOCAL_USER,
                    d.name,
                    d.version,
                    d.columns,
                    JSON.stringify(d.widgets),
                    i,
                ),
            );
        })();
    } catch (err: unknown) {
        console.error(`[dashboards] persist ${DB_FILE}:`, err);
    }
}

dashboards = loadDashboards();

/** Kick channel widgets needed by the persisted dashboards; fans out to dashboard viewers. */
initWidgetHub((msg) => server.publish(WIDGET_HUB_TOPIC, msg));
const syncKick = (): void => syncWidgetHub(dashboards);
syncKick();

class ApiError extends Error {
    constructor(
        message: string,
        readonly code = 400,
    ) {
        super(message);
    }
}

function dashError(code: number, message: string): Response {
    return Response.json({ ok: false, error: message, code });
}

/** Push a dashboard change to the owner's live dashboards topic, so their open
 * dashboards (view/edit pages) re-render without a refresh. */
function broadcastDashboard(d: ServerDashboard): void {
    server.publish(
        dashboardsTopic(d.owner ?? LOCAL_USER),
        event("dashboards.changed", d),
    );
}

/** Dashboards owned by `user`, in stored order. Ownerless (legacy) dashboards
 * belong to the `local` profile. */
const dashboardsFor = (user: string) =>
    dashboards.filter((d) => (d.owner ?? LOCAL_USER) === user);

async function dashApi(
    req: Request,
    url: URL,
    user: string,
): Promise<Response> {
    try {
        const m = url.pathname.match(DASH_PATH_RE);
        if (!m)
            return Response.json({ ok: false, error: "Not found", code: 404 });
        const id = m[1];
        if (!id) {
            // The list is always scoped to the requesting user
            if (req.method === "GET")
                return Response.json({
                    ok: true,
                    dashboards: dashboardsFor(user),
                });
            if (req.method === "POST") {
                const body = (await req.json()) as {
                    name?: unknown;
                    widgets?: unknown;
                };
                const name =
                    typeof body.name === "string" ? body.name.trim() : "";
                if (!name) return dashError(400, "Dashboard needs a name");
                const dashboard: ServerDashboard = {
                    id: randomUUID(),
                    owner: user,
                    name,
                    version: 1,
                    columns: DASH_COLUMNS,
                    widgets: parseWidgets(body.widgets, user),
                };
                dashboards.push(dashboard);
                saveDashboards();
                syncKick();
                broadcastDashboard(dashboard);
                return Response.json(
                    { ok: true, dashboard, dashboards: dashboardsFor(user) },
                    { status: 201 },
                );
            }
            return Response.json({
                ok: false,
                error: "Method not allowed",
                code: 405,
            });
        }
        // Mutations need a body (JSON); the device list is a separate GET.
        // Other users' dashboards are invisible (404, not just hidden).
        const dashboardsById = dashboards.find(
            (d) => d.id === id && (d.owner ?? LOCAL_USER) === user,
        );
        if (req.method === "DELETE") {
            if (!dashboardsById) return dashError(404, "Unknown dashboard");
            dashboards = dashboards.filter((d) => d.id !== id);
            saveDashboards();
            syncKick();
            server.publish(
                dashboardsTopic(user),
                event("dashboards.changed", { id, deleted: true }),
            );
            return Response.json({ ok: true, dashboards: dashboardsFor(user) });
        }
        if (req.method === "PUT") {
            if (!dashboardsById) return dashError(404, "Unknown dashboard");
            const body = (await req.json()) as {
                name?: unknown;
                widgets?: unknown;
                version?: unknown;
            };
            const name = typeof body.name === "string" ? body.name.trim() : "";
            if (!name) return dashError(400, "Dashboard needs a name");
            // Optimistic concurrency: the client must echo the version it based
            // the changes on, or we reject and let it rebase against `current`.
            if (Number(body.version) !== dashboardsById.version) {
                return Response.json(
                    {
                        ok: false,
                        error: "version conflict",
                        current: dashboardsById,
                    },
                    { status: 409 },
                );
            }
            dashboardsById.name = name;
            dashboardsById.widgets = parseWidgets(body.widgets, user);
            dashboardsById.version += 1;
            saveDashboards();
            syncKick();
            broadcastDashboard(dashboardsById);
            return Response.json({
                ok: true,
                dashboard: dashboardsById,
                dashboards: dashboardsFor(user),
            });
        }
        if (req.method === "GET") {
            if (!dashboardsById) return dashError(404, "Unknown dashboard");
            return Response.json({ ok: true, dashboard: dashboardsById });
        }
        return Response.json({
            ok: false,
            error: "Method not allowed",
            code: 405,
        });
    } catch (err: unknown) {
        const code = err instanceof ApiError ? err.code : 500;
        return dashError(
            code,
            err instanceof Error ? err.message : "Internal error",
        );
    }
}

// ----------------------------------------------------------------------
// HTTP / WebSocket server
// ----------------------------------------------------------------------
const deviceSummary = (d: Device): DeviceSummary => ({
    ...deviceInfo(d),
    statusAt: d.statusAt,
    srtla: d.status?.state?.srtla,
    encoder: d.status?.state?.encoder,
    modules: d.status?.modules,
    maxBitrate: d.status?.state?.encoder?.config?.maxBitrate,
    ...(d.stats
        ? {
              bitrate: d.stats.links.reduce(
                  (sum, l) => sum + (l.bitrate_bytes_per_sec || 0),
                  0,
              ),
              activeLinks: d.stats.active_links,
              totalLinks: d.stats.total_links,
          }
        : {}),
});

/** Device list scoped to one user's assignments. */
function summaries(user: string): DeviceSummary[] {
    return [...devices.values()]
        .filter((d) => (d.owner ?? LOCAL_USER) === user)
        .map(deviceSummary)
        .sort(
            (a, b) =>
                Number(b.online) - Number(a.online) || a.id.localeCompare(b.id),
        );
}

/** The set of users with at least one registered device. */
const deviceOwners = (): string[] => {
    const owners = new Set<string>();
    for (const d of devices.values()) owners.add(d.owner ?? LOCAL_USER);
    return [...owners];
};

// The per-device push cadence (2 s stats × N devices + 30 s status) would
// flood the dashboard feed with a full-list re-broadcast even when nothing
// visible changed — so the list is throttled: at most once per tick (2 s),
// and only when a visible summary field changed (timestamps excluded —
// they are refreshed by the slow pass below).
const LIST_TICK_MS = 2_000;
const LIST_SLOW_PASS_MS = 30_000;
const VOLATILE_KEYS = new Set<PropertyKey>(["lastSeen", "statusAt"]);
/** JSON of the summary without the per-push volatile timestamps. */
const stableFingerprint = (list: DeviceSummary[]): string =>
    JSON.stringify(
        list.map((d) =>
            Object.fromEntries(
                Object.entries(d).filter(([k]) => !VOLATILE_KEYS.has(k)),
            ),
        ),
    );

// Per-user fingerprints: a change to user A's devices must not re-kick
// user B's (unchanged) list feed.
const listFingerprints = new Map<string, string>();
let lastListsFingerprint = "";
let listPublishedAt = 0;

/** One stable fingerprint over every user's current list. */
const listsFingerprint = (): string =>
    deviceOwners()
        .sort()
        .map((u) => `${u}:${stableFingerprint(summaries(u))}`)
        .join("|");

function publishDeviceListNow(): void {
    listPublishedAt = Date.now();
    lastListsFingerprint = listsFingerprint();
    // Publish per owner so each client only hears about its own devices.
    for (const user of deviceOwners()) {
        const list = summaries(user);
        const fingerprint = stableFingerprint(list);
        if (listFingerprints.get(user) === fingerprint) continue;
        listFingerprints.set(user, fingerprint);
        server.publish(devicesTopic(user), event("devices.changed", list));
    }
}

/** Re-broadcast the per-user lists to the live-feed subscribers; each list
 * is identical to what the pages fetch from /api/devices. Throttled to at
 * most one broadcast per tick and skipped when nothing visible changed —
 * except structural events (connect / disconnect / identity), which pass
 * immediate. */
function publishDeviceList(immediate = false): void {
    const now = Date.now();
    if (!immediate && now - listPublishedAt < LIST_TICK_MS) return;
    if (immediate || listsFingerprint() !== lastListsFingerprint)
        publishDeviceListNow();
}

// A slow pass keeps the volatile time columns (since / last seen) accurate
// while devices are idle — the list is small, one full snapshot per 30 s.
setInterval(publishDeviceListNow, LIST_SLOW_PASS_MS);

/** Device connection (`/device`): authenticate by uuid + token, then upgrade. */
function deviceUpgrade(
    req: Request,
    url: URL,
    srv: Bun.Server<WsData>,
): Response | undefined {
    const id =
        req.headers.get("x-device-id") ?? url.searchParams.get("id") ?? "";
    const token =
        req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const address = srv.requestIP(req)?.address ?? "";
    if (!ID_RE.test(id)) return text("Missing or invalid x-device-id", 400);
    // The connect token assigns the device to the presenting user
    const user = userForToken(token);
    if (!user) {
        console.warn(
            `[device ${id}] rejected: bad token from ${address || "?"}`,
        );
        return text("Unauthorized", 401);
    }
    const existing = devices.get(id);
    if (existing && (existing.owner ?? LOCAL_USER) !== user) {
        console.warn(
            `[device ${id}] rejected from ${address || "?"}: assigned to a different user`,
        );
        return text("Forbidden", 403);
    }
    const role = req.headers.get("x-device-role");
    if (
        srv.upgrade(req, {
            data: {
                kind: "device",
                id,
                address,
                owner: user,
                role: isRole(role) ? role : undefined,
            },
        })
    )
        return undefined;
    return upgradeRequired();
}

/** Pages and the viewer socket of one device (`/d/<id>/…`). */
function devicePath(
    req: Request,
    url: URL,
    srv: Bun.Server<WsData>,
    m: RegExpMatchArray,
    user: string,
): Response | undefined {
    const [, rawId, slash, ws, page, pageSlash] = m;
    const id = decodeURIComponent(rawId);
    if (!ID_RE.test(id)) return text("Invalid device id", 400);
    // Only the user a device is assigned to may view or attach to it
    const d = devices.get(id);
    if (!d || (d.owner ?? LOCAL_USER) !== user) return notFound();
    const base = `/d/${encodeURIComponent(id)}/`;
    if (ws) {
        if (!originAllowed(req)) return text("Origin not allowed", 403);
        if (srv.upgrade(req, { data: { kind: "viewer", id, user } }))
            return undefined;
        return upgradeRequired();
    }
    if (page)
        return pageSlash
            ? htmlResponse(page as PageName)
            : Response.redirect(`${base}${page}/`, 308);
    if (!slash) return Response.redirect(base, 308);
    // Devices without a config file serve the setup wizard instead of the UI
    const setupRequired =
        d.status?.setupRequired && !url.searchParams.has("ui");
    return htmlResponse(setupRequired ? "setup" : "index");
}

const server = Bun.serve({
    hostname: HOST,
    port: PORT,

    async fetch(req, srv) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (path === "/healthz") return text("ok");
        if (path === "/device") return deviceUpgrade(req, url, srv);

        // Public routes: the login + register pages and their (content-hashed)
        // assets and locale catalogs need no session.
        if (path === "/login") {
            if (db && !hasUsers()) return Response.redirect("/register", 302);
            return htmlResponse("login");
        }
        if (path === "/register") return htmlResponse("register");
        if (path.startsWith("/assets/")) {
            const asset = assets.get(path.slice("/assets/".length));
            return asset
                ? new Response(asset, {
                      headers: {
                          "cache-control":
                              "public, max-age=31536000, immutable",
                      },
                  })
                : notFound();
        }
        if (path.startsWith("/i18n/")) return await i18nResponse(path, catalog);
        if (path === "/api/login" && req.method === "POST")
            return loginResponse(req);
        if (path === "/api/register" && req.method === "POST")
            return registerResponse(req);
        if (path === "/api/register/status" && req.method === "GET")
            return registerStatusResponse();
        if (path === "/api/logout" && req.method === "POST")
            return logoutResponse(req);

        // Everything else requires an authenticated user
        const user = userFromRequest(req);
        if (!user) {
            // Send first-time visitors straight to bootstrap registration.
            if (req.method === "GET" && !path.startsWith("/api/"))
                return Response.redirect(
                    db && !hasUsers() ? "/register" : "/login",
                    302,
                );
            return unauthorized();
        }

        if (path === "/") return htmlResponse("devices");
        if (path === "/api/devices") return Response.json(summaries(user));
        if (path === "/profile/") return htmlResponse("profile");
        if (path === "/profile") return Response.redirect("/profile/", 308);
        if (path === "/api/whoami") return whoamiResponse(user);
        if (path === "/api/profile" && req.method === "GET")
            return profileResponse(user);
        if (path === "/api/profile/password" && req.method === "POST")
            return changePasswordResponse(req, user);
        if (path === "/api/profile/tokens" && req.method === "POST")
            return createTokenResponse(user);
        const tokenDel = path.match(/^\/api\/profile\/tokens\/([^/]+)$/);
        if (tokenDel && req.method === "DELETE")
            return deleteTokenResponse(url, user);
        if (path === "/api/invitations" && req.method === "GET")
            return listInvitationsResponse(req);
        if (path === "/api/invitations" && req.method === "POST")
            return createInvitationResponse(req);
        if (path === "/dashboards/") return htmlResponse("dashboards");
        if (path.startsWith("/api/dashboards")) return dashApi(req, url, user);
        if (path === "/dashboards/ws") {
            // The dashboard pages' live kick data channel (stats + chat)
            if (!originAllowed(req)) return text("Origin not allowed", 403);
            if (srv.upgrade(req, { data: { kind: "dashboards", user } }))
                return undefined;
            return upgradeRequired();
        }
        if (
            path.startsWith("/dashboards/view/") ||
            path.startsWith("/dashboards/edit/")
        ) {
            // Both routes serve the merged inline grid editor; the page enables
            // editing when the URL is /dashboards/edit/.
            return htmlResponse("dashboardview");
        }
        if (path.startsWith("/dashboards/add/")) {
            // The dedicated "add widget" page for a single dashboard.
            return htmlResponse("dashboardadd");
        }
        const pm = path.match(PIPELINE_EDIT_RE);
        if (pm) {
            // The dedicated pipeline editor page (new / edit) for a device.
            const id = decodeURIComponent(pm[1]);
            if (!ID_RE.test(id)) return text("Invalid device id", 400);
            const d = devices.get(id);
            if (!d || (d.owner ?? LOCAL_USER) !== user) return notFound();
            return htmlResponse("pipelineedit");
        }
        const m = path.match(DEVICE_PATH_RE);
        if (m) return devicePath(req, url, srv, m, user);
        return (await imageResponse(path)) ?? notFound();
    },

    websocket: {
        data: {} as WsData,

        open(ws) {
            const { data } = ws;
            if (data.kind === "dashboards") {
                // User-scoped feeds: widget hub, own dashboards, own devices
                ws.subscribe(WIDGET_HUB_TOPIC);
                ws.subscribe(dashboardsTopic(data.user));
                ws.subscribe(devicesTopic(data.user));
                ws.send(event("widget.snapshot", widgetHubSnapshot()));
                ws.send(
                    event("dashboards.snapshot", {
                        dashboards: dashboardsFor(data.user),
                    }),
                );
                ws.send(event("devices.snapshot", summaries(data.user)));
                return;
            }
            if (data.kind === "device") {
                const d = deviceFor(data.id);
                if (d.ws) d.ws.close(4001, "replaced by a new connection");
                d.ws = ws;
                d.address = data.address;
                d.owner = data.owner;
                d.role = data.role ?? d.role;
                d.connectedAt = d.lastSeen = Date.now();
                console.log(`[device ${d.id}] connected from ${data.address}`);
                publish(d, deviceEvent(d));
                addServerLog(
                    d,
                    "info",
                    translate(d.language, "srv.online", {
                        address: data.address,
                    }),
                );
                publishDeviceList(true);
                return;
            }
            // Viewers of never-seen devices must not grow the registry
            const d = devices.get(data.id) ?? newDevice(data.id);
            ws.subscribe(viewersTopic(d.id));
            ws.send(deviceEvent(d));
            ws.send(logHistory(d));
            if (d.statusMsg) ws.send(d.statusMsg);
            if (d.statsMsg) ws.send(d.statsMsg);
        },

        message(ws, raw) {
            const { data } = ws;
            if (data.kind === "dashboards") return; // the hub pushes only
            if (data.kind === "viewer")
                return onViewerMessage(ws, data.id, data.user, raw);
            const d = devices.get(data.id);
            if (d && d.ws === ws) onDeviceMessage(d, raw);
        },

        close(ws, code, reason) {
            const { data } = ws;
            if (data.kind === "dashboards") return;
            if (data.kind === "viewer") {
                failPending((p) => p.viewer === ws, "", 0, false);
                return;
            }
            const d = devices.get(data.id);
            if (!d || d.ws !== ws) return; // an older, replaced connection
            d.ws = null;
            d.statsMsg = undefined; // live telemetry; viewers clear it on the offline device event
            d.stats = undefined;
            const why = `${code}${reason ? `: ${reason}` : ""}`;
            console.log(`[device ${d.id}] disconnected (${why})`);
            failPending((p) => p.deviceId === d.id, "device disconnected", 503);
            publish(d, deviceEvent(d));
            addServerLog(
                d,
                "warn",
                translate(d.language, "srv.offline", { reason: why }),
            );
            publishDeviceList(true);
        },
    },
});

// A device entry is dropped from the list once it has been silent for this long
// (lastSeen covers every frame received from the device, refreshed on connect).
setInterval(() => {
    const now = Date.now();
    for (const d of [...devices.values()]) {
        const seen = d.lastSeen ?? d.connectedAt ?? 0; // never-heard-from phantoms use epoch 0
        if (now - seen <= STALE_DEVICE_MS) continue;
        d.ws?.close(4000, "removed after inactivity");
        devices.delete(d.id);
        failPending((p) => p.deviceId === d.id, "device disconnected", 503);
        publish(d, deviceEvent(d));
        publishDeviceList(true);
        console.log(
            `[device ${d.id}] removed: no heartbeat for >${STALE_DEVICE_MS / 60000} minutes`,
        );
    }
}, PRUNE_INTERVAL_MS);

console.log(`SRTLA control server on http://${HOST}:${server.port}/`);
console.log(
    `Relays connect with: --remote ws://<this-host>:${server.port}/device`,
);
if (NO_AUTH)
    console.warn(
        "WARNING: --no-auth — anyone can register devices and control them.",
    );
