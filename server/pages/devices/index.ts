/*
 * The devices page module: registry + routes (server/) and the device list
 * page (client/, pages/). init builds the registry, publishes it as the
 * "devices" capability for other pages and the module control routes, and
 * fills the route plugin; start begins the maintenance sweep, which needs
 * the live server and so runs after listen.
 */
import { Elysia } from "elysia";
import type { PageModule, PageServices } from "../../../core/contracts";
import { createDevices } from "./server/registry";
import { mountDeviceRoutes } from "./server/routes";
import menu from "./client/menu";

const routes = new Elysia({ name: "page-devices" });
let devices: ReturnType<typeof createDevices> | undefined;

export default {
    id: "devices",
    menu,
    server: {
        routes,
        init: async (s: PageServices) => {
            devices = createDevices({
                publish: s.publish,
                userForToken: s.auth.userForToken,
            });
            s.capabilities.provide("devices", devices);
            mountDeviceRoutes(routes, s, devices);
        },
        start: () => {
            devices?.startMaintenance();
        },
    },
    client: {
        pages: ["device_list"],
    },
} satisfies PageModule;
