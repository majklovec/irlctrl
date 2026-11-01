/*
 * The device list: its page (`/devices/`, also the home page `/`) and the
 * summaries API it reads.
 */
import { Elysia } from "elysia";
import type { createFrontend } from "../../../shared/frontend";
import type { createAuth } from "../auth/auth";
import { authenticatedHandler } from "../auth/authenticated";
import type { createDevices } from "./device_registry";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Devices = ReturnType<typeof createDevices>;
type Frontend = Awaited<ReturnType<typeof createFrontend>>;

export function deviceListRoutes(
	auth: Auth,
	devices: Devices,
	frontend: Frontend,
) {
	const page = authenticatedHandler(auth, () =>
		frontend.htmlResponse("device_list"),
	);
	return new Elysia({ name: "control-device-list" })
		.get("/", page)
		.get("/devices/", page)
		.get(
			"/api/devices",
			authenticatedHandler(auth, (_request, user) =>
				Response.json(devices.summaries(user)),
			),
		);
}
