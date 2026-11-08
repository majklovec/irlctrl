/*
 * The devices page module: registry + routes (server/) and the device list
 * page (client/, pages/). init builds the registry, publishes it as the
 * "devices" capability for other pages and the module control routes, and
 * fills the route plugin; start begins the maintenance sweep, which needs
 * the live server and so runs after listen.
 */
import { Elysia } from "elysia";
import type { PageModule, PageServices } from "../../../core/contracts";
import { createDevices } from "./backend/registry";
import { mountDeviceRoutes } from "./backend/routes";
import menu from "./frontend/menu";

const routes = new Elysia({ name: "page-devices" });
let devices: ReturnType<typeof createDevices> | undefined;

export default {
    id: "devices",
    menu,
    dependencies: ["projects"],
    backend: {
        routes,
        init: async (s: PageServices) => {
            devices = createDevices({
                publish: s.publish,
                // Device connect tokens resolve to a project (migration 0012);
                // in --no-auth mode auth.projectForToken returns the local id.
                projectForToken: s.auth.projectForToken,
            });
            s.capabilities.provide("devices", devices);
            mountDeviceRoutes(routes, s, devices);
        },
        start: () => {
            devices?.startMaintenance();
        },
    },
    frontend: {
        pages: ["device_list"],
    },
} satisfies PageModule;
