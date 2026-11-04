/*
 * Core services factory: the entity-agnostic stuff every page receives
 * (db, auth, publish, config, the frontend bundler) plus the capability
 * map that carries the cross-page state. The composition entry builds
 * these once and hands them to discoverPages; pages never reach for
 * auth/, db.ts or socket.ts directly.
 *
 * `publish` is a stable handle delegating to the Elysia app created by
 * core/app.ts (the app is built after the services, the page routes are
 * mounted after both) — so a page always publishes onto the live server.
 */
import type { Database } from "bun:sqlite";
import { createAuth } from "./auth/auth";
import { createFrontend } from "../../shared/frontend";
import type {
    Auth,
    CapabilityRegistry,
    Frontend,
    Publish,
    ServerConfig,
} from "./contracts";
import { createCapabilities } from "./registry";

export interface Services {
    db: Database | null;
    auth: Auth;
    publish: Publish;
    config: ServerConfig;
    frontend: Frontend;
    capabilities: CapabilityRegistry;
    /** Bind the publish handle to a live Elysia app (core/app.ts does this). */
    bindPublish(target: { publish(topic: string, message: string): void }): void;
}

export async function createServices(
    config: ServerConfig,
): Promise<Services> {
    const auth = await createAuth({
        noAuth: config.noAuth,
        databaseFile: config.databaseFile,
    });
    const frontend = await createFrontend();
    let bound: { publish(topic: string, message: string): void } | null = null;

    return {
        db: auth.db,
        auth,
        publish: (topic, message) => bound?.publish(topic, message),
        config,
        frontend,
        capabilities: createCapabilities(),
        bindPublish(target) {
            bound = target;
        },
    };
}
