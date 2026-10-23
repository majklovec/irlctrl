#!/usr/bin/env bun
/*
 * SRTLA control server: browser sessions, per-user devices and dashboards.
 * Devices connect with `backend/client/client.ts --remote ws(s)://host:port/device`.
 *
 * Usage: bun backend/server/server.ts --port 8090
 */
import { arg, flag, intArg } from "../../shared/args";
import { createControlServer } from "./control-server";

const PORT = intArg("--port", 8090, 1, 65535);
const HOST = arg("--host", "0.0.0.0");
const NO_AUTH = flag("--no-auth");
const DB_FILE = arg("--db", process.env.DB_FILE ?? "users.db");

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
console.log(`SRTLA control server on http://${HOST}:${port}/`);
console.log(`Relays connect with: --remote ws://<this-host>:${port}/device`);
if (NO_AUTH)
	console.warn(
		"WARNING: --no-auth — anyone can register devices and control them.",
	);
