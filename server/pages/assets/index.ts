/*
 * The assets page module: the media library (file/folder store backed by
 * disk + the user db) and its list page. Provides the "assets" capability
 * the overlays slice pulls (the OBS runtime page serves asset-library
 * files).
 */
import { Elysia } from "elysia";
import type { PageModule, PageServices } from "../../../core/contracts";
import { createAssets } from "./backend/registry";
import { mountAssetRoutes } from "./backend/routes";
import menu from "./frontend/menu";

const routes = new Elysia({ name: "page-assets" });

export default {
    id: "assets",
    menu,
    backend: {
        routes,
        init: async (s: PageServices) => {
            const assets = createAssets({
                db: s.db,
                storageDir: s.config.storageDir,
            });
            s.capabilities.provide("assets", assets);
            mountAssetRoutes(routes, s, assets);
        },
    },
    frontend: {
        pages: ["assets_list"],
    },
} satisfies PageModule;
