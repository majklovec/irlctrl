/*
 * The overlays page module. The runtime page (loaded by OBS) serves files
 * of the owner's asset library, so the routes need the assets store —
 * pulled from the "assets" capability the assets page provides (declared
 * in `dependencies` so it inits first).
 */
import { Elysia } from "elysia";
import type { PageModule, PageServices } from "../../../core/contracts";
import type { Assets } from "../assets/server/registry";
import { createOverlays } from "./server/registry";
import { mountOverlayRoutes } from "./server/routes";
import menu from "./client/menu";

const routes = new Elysia({ name: "page-overlays" });

export default {
    id: "overlays",
    dependencies: ["assets"],
    menu,
    server: {
        routes,
        init: async (s: PageServices) => {
            const assets = s.capabilities.require<Assets>("assets");
            const overlays = createOverlays({
                db: s.db,
                databaseFile: s.config.databaseFile,
                publish: s.publish,
            });
            s.capabilities.provide("overlays", overlays);
            mountOverlayRoutes(routes, s, overlays, assets);
        },
    },
    client: {
        pages: ["overlay_list", "overlay_update", "overlay_view"],
    },
} satisfies PageModule;
