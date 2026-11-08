import type { createAuth } from "./auth";

type Auth = Awaited<ReturnType<typeof createAuth>>;

export function unauthenticatedResponse(
    auth: Auth,
    request: Request,
): Response {
    const url = new URL(request.url);
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        // Preserve the original route so we can return to it after login.
        const next =
            url.pathname !== "/" ? url.pathname + url.search : "/";
        const target = `${auth.db && !auth.hasUsers() ? "/register" : "/login"}?next=${encodeURIComponent(next)}`;
        return Response.redirect(target, 302);
    }
    return auth.unauthorized();
}

export function authenticatedHandler<T>(
    auth: Auth,
    handler: (request: Request, user: string) => T,
) {
    return ({ request }: { request: Request }) => {
        const user = auth.userFromRequest(request);
        if (!user) return unauthenticatedResponse(auth, request);
        return handler(request, user);
    };
}
