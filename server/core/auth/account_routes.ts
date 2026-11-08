import { Elysia } from "elysia";
import type { createFrontend } from "../../../shared/frontend";
import type { createAuth } from "./auth";
import { authenticatedHandler } from "./authenticated";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Frontend = Awaited<ReturnType<typeof createFrontend>>;

export function accountRoutes(auth: Auth, frontend: Frontend) {
    return new Elysia({ name: "control-account" })
        .get(
            "/profile",
            authenticatedHandler(auth, () => frontend.htmlResponse("profile")),
        )
        .get(
            "/api/whoami",
            authenticatedHandler(auth, (_request, user) =>
                auth.whoamiResponse(user),
            ),
        )
        .get(
            "/api/profile",
            authenticatedHandler(auth, (_request, user) =>
                auth.profileResponse(user),
            ),
        )
        .post(
            "/api/profile/password",
            authenticatedHandler(auth, (request, user) =>
                auth.changePasswordResponse(request, user),
            ),
        )
        .get(
            "/api/invitations",
            authenticatedHandler(auth, (request) =>
                auth.listInvitationsResponse(request),
            ),
        )
        .post(
            "/api/invitations",
            authenticatedHandler(auth, (request) =>
                auth.createInvitationResponse(request),
            ),
        );
}
