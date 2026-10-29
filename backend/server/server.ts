#!/usr/bin/env bun
/*
 * irlctrl control server: browser sessions, per-user devices and dashboards.
 * Devices connect with `backend/client/client.ts --remote ws(s)://host:port/device`.
 *
 * Usage: bun backend/server/server.ts --port 8090
 */
import { argEnv, flagOrEnv, intArgEnv } from "../../shared/args";
import { createControlServer } from "./control-server";

const PORT = intArgEnv("--port", "SERVER_PORT", 8090, 1, 65535);
const HOST = argEnv("--host", "SERVER_HOST", "0.0.0.0");
const NO_AUTH = flagOrEnv("--no-auth", "NO_AUTH");
const DB_FILE = argEnv("--db", "DB_FILE", "users.db");

const app = await createControlServer({
    hostname: HOST,
    port: PORT,
    noAuth: NO_AUTH,
    databaseFile: DB_FILE,
    frontendDirectory: new URL("../../frontend/", import.meta.url),
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
