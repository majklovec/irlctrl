#!/usr/bin/env bun
/*
 * irlctrl control server: browser sessions, per-user devices and dashboards.
 * Devices connect with `client/backend/client.ts --remote ws(s)://host:port/device`.
 *
 * Usage: bun server/main.ts --port 8090
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { argEnv, flagOrEnv, intArgEnv } from "../shared/args";
import { ensureGeneratedManifests } from "../shared/generated_manifests";
import { appPath } from "../shared/paths";

// generated/ first: the application graph statically imports the manifests.
await ensureGeneratedManifests();
const { createControlServer } = await import("./core/app");

const PORT = intArgEnv("--port", "SERVER_PORT", 8090, 1, 65535);
const HOST = argEnv("--host", "SERVER_HOST", "0.0.0.0");
const NO_AUTH = flagOrEnv("--no-auth", "NO_AUTH");
const DB_FILE = argEnv("--db", "DB_FILE", "users.db");
const STORAGE_DIR = argEnv("--storage", "STORAGE_DIR", "assets");

/**
 * A fresh storage dir (a bind-mounted volume in Docker/Nomad) has no overlay
 * templates: seed it once from the templates shipped with the app
 * (assets/overlay_templates in the repo and the image). A directory the user
 * already owns — even an emptied one — is never re-seeded.
 */
function seedOverlayTemplates(destDir: string) {
    const seedDir = appPath("assets/overlay_templates");
    if (existsSync(destDir) || !existsSync(seedDir)) return;
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(seedDir, { withFileTypes: true }))
        if (entry.isFile() && entry.name.endsWith(".html"))
            copyFileSync(join(seedDir, entry.name), join(destDir, entry.name));
}
seedOverlayTemplates(join(STORAGE_DIR, "overlay_templates"));

const app = await createControlServer({
    hostname: HOST,
    port: PORT,
    noAuth: NO_AUTH,
    databaseFile: DB_FILE,
    storageDir: STORAGE_DIR,
});

const port = app.server?.port;
if (port === undefined)
    throw new Error("Elysia failed to start the control server");
console.log(`irlctrl control server on http://${HOST}:${port}/`);
console.log(`Relays connect with: --remote ws://<this-host>:${port}/device`);
if (NO_AUTH)
    console.warn(
        "WARNING: --no-auth — anyone can register devices and control them.",
    );
