import { Elysia } from "elysia";
import type { createAuth } from "../auth/auth";
import type { createDevices } from "./device_registry";
import { authenticatedHandler } from "../auth/authenticated";

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
