import { Elysia } from "elysia";
import type { createAuth } from "../auth";
import type { createDevices } from "../devices";
import { authenticatedHandler } from "./authenticated";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Devices = ReturnType<typeof createDevices>;

export function deviceListRoutes(auth: Auth, devices: Devices) {
    return new Elysia({ name: "control-device-list" }).get(
        "/api/devices",
        authenticatedHandler(auth, (_request, user) =>
            Response.json(devices.summaries(user)),
        ),
    );
}
