/*
 * Device-local web authentication: when the device's config file holds the
 * credentials registered in the setup wizard, the web UI (HTML pages and the
 * RPC socket) is guarded by a username + password login.
 *
 * Same scheme as the control server (server/core/auth): a scrypt password hash
 * and opaque HttpOnly cookie sessions, so the password never lives in the
 * browser and WebSocket upgrades inherit the session cookie automatically.
 *
 * Authentication is enabled by the config file *at startup*: credentials
 * registered mid-run in the setup wizard only take effect after the restart
 * the wizard already requires.
 */
import {
	randomBytes,
	randomUUID,
	scryptSync,
	timingSafeEqual,
} from "node:crypto";
import { text } from "../../shared/http";
import { INITIAL_CONFIG } from "./config";

/** scrypt password hash: `scrypt$<salt hex>$<hash hex>`. */
export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString("hex");
	return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}
/** Constant-time check of a password against a stored hash. */
export function verifyPassword(password: string, stored: string): boolean {
	const parts = stored.split("$");
	if (parts.length !== 3 || parts[0] !== "scrypt") return false;
	const expected = Buffer.from(parts[2], "hex");
	if (expected.length === 0) return false;
	return timingSafeEqual(
		scryptSync(password, parts[1], expected.length),
		expected,
	);
}

const startup = (INITIAL_CONFIG ?? {}) as {
	username?: unknown;
	passwordHash?: unknown;
};
const STARTUP_USERNAME =
	typeof startup.username === "string" ? startup.username : "";
const STARTUP_HASH =
	typeof startup.passwordHash === "string" ? startup.passwordHash : "";

/** True when the loaded config carries web-login credentials. */
export const authEnabled =
	STARTUP_USERNAME.length > 0 && STARTUP_HASH.length > 0;

/** One dummy scrypt verify so login timing does not depend on the hash. */
const DUMMY_HASH = hashPassword("__padding__");

/** Timing-safe check of credentials against the startup ones. */
export function authenticate(username: string, password: string): boolean {
	if (STARTUP_USERNAME.length === 0) return false;
	if (username !== STARTUP_USERNAME) {
		verifyPassword(password, DUMMY_HASH);
		return false;
	}
	return verifyPassword(password, STARTUP_HASH);
}

// Opaque cookie sessions: the browser stores a session id (HttpOnly), the
// password never does.
const SESSION_COOKIE = "irlctrl_device_session";
const sessions = new Set<string>();

function sessionCookie(req: Request): string | null {
	const raw = req.headers.get("cookie");
	if (!raw) return null;
	for (const part of raw.split(";")) {
		const idx = part.indexOf("=");
		if (idx > 0 && part.slice(0, idx).trim() === SESSION_COOKIE)
			return part.slice(idx + 1).trim() || null;
	}
	return null;
}

/** Whether the request carries a valid session (always true when auth is off). */
export function sessionFromRequest(req: Request): boolean {
	if (!authEnabled) return true;
	const id = sessionCookie(req);
	if (!id) return false;
	if (!sessions.has(id)) sessions.delete(id);
	return sessions.has(id);
}

/** POST /login — exchange username + password for the session cookie. */
export async function loginRoute(req: Request): Promise<Response> {
	if (!authEnabled) return text("Authentication disabled", 404);
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
		return text("Invalid JSON", 400);
	}
	if (
		typeof username !== "string" ||
		typeof password !== "string" ||
		!authenticate(username, password)
	)
		return text("Invalid username or password", 401);
	const id = randomUUID();
	sessions.add(id);
	return Response.json(
		{ ok: true },
		{
			headers: {
				"set-cookie": `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`,
			},
		},
	);
}

/** POST /logout — drop the session and clear the cookie. */
export function logoutRoute(req: Request): Response {
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
