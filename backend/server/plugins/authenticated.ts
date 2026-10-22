import { Elysia } from "elysia";
import type { createAuth } from "../auth";

type Auth = Awaited<ReturnType<typeof createAuth>>;

export function unauthenticatedResponse(
    auth: Auth,
    request: Request,
): Response {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && !path.startsWith("/api/"))
        return Response.redirect(
            auth.db && !auth.hasUsers() ? "/register" : "/login",
            302,
        );
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
