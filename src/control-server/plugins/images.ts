import { Elysia } from "elysia";
import { imageResponse, notFound } from "../../http";
import type { createAuth } from "../auth";
import { authenticatedHandler } from "./authenticated";

type Auth = Awaited<ReturnType<typeof createAuth>>;

export function imageRoutes(auth: Auth) {
    return new Elysia({ name: "control-images" }).all(
        "/img/*",
        authenticatedHandler(auth, async (request) =>
            (await imageResponse(new URL(request.url).pathname)) ?? notFound(),
        ),
    );
}
