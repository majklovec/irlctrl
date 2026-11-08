/*
 * The `?project=<id>` query parameter every project-scoped entity API call
 * carries. The browser half always sends the active project's id; the server
 * resolves it to the caller's role in that project (core's `ProjectAccess`).
 * The id charset matches the route path segments used across the API.
 */

/** The charset a project id may use (mirrors the route `:id` segments). */
export const PROJECT_ID_RE = /^[\w.-]{1,64}$/;

/**
 * Read the `?project=<id>` parameter. `null` when absent or malformed — the
 * caller decides whether a missing project is a 400 (entity APIs require it)
 * or an acceptable default.
 */
export function projectParam(url: URL): string | null {
	const raw = url.searchParams.get("project");
	if (!raw) return null;
	return PROJECT_ID_RE.test(raw) ? raw : null;
}
