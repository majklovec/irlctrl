import { Elysia } from "elysia";
import type { createAuth } from "../auth";
import type { createFrontend } from "../../frontend";
import { authenticatedHandler } from "./authenticated";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Frontend = Awaited<ReturnType<typeof createFrontend>>;

export function accountRoutes(auth: Auth, frontend: Frontend) {
    return new Elysia({ name: "control-account" })
        .get(
            "/",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("devices"),
            ),
        )
        .get(
            "/profile",
            authenticatedHandler(auth, () =>
                Response.redirect("/profile/", 308),
            ),
        )
        .get(
            "/profile/",
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
        .post(
            "/api/profile/tokens",
            authenticatedHandler(auth, (_request, user) =>
                auth.createTokenResponse(user),
            ),
        )
        .delete(
            "/api/profile/tokens/:tokenId",
            authenticatedHandler(auth, (request, user) =>
                auth.deleteTokenResponse(new URL(request.url), user),
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
