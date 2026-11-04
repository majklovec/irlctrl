/*
 * The dashboards page module. Depends on the devices page: the store
 * validates dashboard widgets against the device registry (ownsDevice /
 * deviceExists / deviceStatus), reached through the "devices" capability.
 */
import { Elysia } from "elysia";
import type { PageModule, PageServices } from "../../../core/contracts";
import type { createDevices } from "../devices/server/registry";
import { createDashboards } from "./server/registry";
import { mountDashboardRoutes } from "./server/routes";
import menu from "./client/menu";

type Devices = ReturnType<typeof createDevices>;

const routes = new Elysia({ name: "page-dashboards" });

export default {
    id: "dashboards",
    dependencies: ["devices"],
    menu,
    server: {
        routes,
        init: async (s: PageServices) => {
            const devices = s.capabilities.require<Devices>("devices");
            const dashboards = createDashboards({
                db: s.db,
                databaseFile: s.config.databaseFile,
                publish: s.publish,
                ownsDevice: (id, user) => devices.ownsDevice(id, user),
                deviceExists: (id) => !!devices.getDevice(id),
                deviceStatus: (id) => devices.getDevice(id)?.status,
            });
            s.capabilities.provide("dashboards", dashboards);
            mountDashboardRoutes(routes, s, dashboards);
        },
    },
    client: {
        pages: [
            "dashboard_list",
            "dashboard_add",
            "dashboard_view",
            "dashboard_update",
        ],
    },
} satisfies PageModule;
