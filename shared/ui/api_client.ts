/*
 * The one way browser code calls the JSON API. Every request carries the
 * JSON content type and `cache: "no-store"`; every response is parsed once;
 * a non-2xx status or an `{ ok: false, error }` body becomes an `ApiError`
 * with the server's message, so pages handle failures in one shape.
 */

export class ApiError extends Error {
	constructor(
		message: string,
		/** HTTP status (0 when the request never reached the server). */
		readonly status: number,
		/** The server's own error code, when its body carried one. */
		readonly code?: number,
		/** The parsed response body (e.g. a 409's `current` copy); null when it was not JSON. */
		readonly body: unknown = null,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export interface ApiInit {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** JSON-serialised into the request body. */
	body?: unknown;
	signal?: AbortSignal;
}

interface ErrorBody {
	ok?: boolean;
	error?: string;
	code?: number;
}

/** Call the API; resolves with the parsed JSON body, rejects with `ApiError`. */
export async function apiJson<T>(path: string, init: ApiInit = {}): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, {
			method: init.method ?? (init.body === undefined ? "GET" : "POST"),
			headers: { "Content-Type": "application/json" },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			cache: "no-store",
			signal: init.signal,
		});
	} catch (err) {
		throw new ApiError(err instanceof Error ? err.message : "Network error", 0);
	}
	const body = (await res.json().catch(() => null)) as (T & ErrorBody) | null;
	if (!res.ok || body === null || body.ok === false)
		throw new ApiError(
			body?.error ?? `HTTP ${res.status}`,
			res.status,
			body?.code,
			body,
		);
	return body;
}

/** `apiJson` for fire-and-forget reads: logs the failure and resolves null. */
export async function apiTry<T>(
	path: string,
	init: ApiInit = {},
): Promise<T | null> {
	try {
		return await apiJson<T>(path, init);
	} catch (err) {
		console.error(`api ${init.method ?? "GET"} ${path}:`, err);
		return null;
	}
}

/** The message to show a user for a failed call. */
export const apiErrorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

/** True when a call failed because the session is missing or expired. */
export const isUnauthorized = (err: unknown): boolean =>
	err instanceof ApiError && err.status === 401;
