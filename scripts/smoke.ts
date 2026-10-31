#!/usr/bin/env bun
/*
 * Smoke check: boot the control server (no auth, throwaway database) and a
 * device client (dry run, throwaway config) on free ports, request every
 * page both processes serve plus their health/API basics, and fail on
 * anything but HTTP 200. Catches broken page wiring, asset bundling and
 * module discovery after a restructure without any browser.
 *
 *   bun scripts/smoke.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES } from "../shared/frontend-pages";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_ENTRY = "backend/server/server.ts";
const CLIENT_ENTRY = "backend/client/client.ts";

/** Control-server routes per page (login/register redirect when no-auth). */
const SERVER_ROUTES: Partial<Record<(typeof PAGES)[number], string>> = {
	devices: "/",
	profile: "/profile/",
	dashboards: "/dashboards/",
	dashboardview: "/dashboards/view/smoke/",
	dashboardadd: "/dashboards/add/smoke/",
	overlays: "/overlays/",
	overlay: "/overlay/smoke",
};
const SERVER_EXTRA = [
	"/healthz",
	"/api/whoami",
	"/api/devices",
	"/api/dashboards",
	"/i18n/en.json",
];
/** Device-client routes (a fresh config → setup page at `/`). */
const CLIENT_ROUTES = ["/", "/setup/", "/settings/", "/i18n/en.json"];

async function freePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((ok, fail) => {
		listener.once("error", fail);
		listener.listen(0, "127.0.0.1", () => ok());
	});
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("no port");
	await new Promise<void>((ok) => listener.close(() => ok()));
	return address.port;
}

async function waitFor(url: string, deadlineMs = 60_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
			last = `${res.status}`;
		} catch (err) {
			last = err;
		}
		await Bun.sleep(250);
	}
	throw new Error(`${url} did not come up: ${String(last)}`);
}

async function check(base: string, paths: string[], failures: string[]) {
	for (const path of paths) {
		try {
			const res = await fetch(base + path, { redirect: "manual" });
			if (res.status !== 200) failures.push(`${path} → ${res.status}`);
			else console.log(`  ok  ${path}`);
		} catch (err) {
			failures.push(`${path} → ${String(err)}`);
		}
	}
}

const tmp = await mkdtemp(join(tmpdir(), "irlctrl-smoke-"));
const serverPort = await freePort();
const clientPort = await freePort();
const procs: ReturnType<typeof Bun.spawn>[] = [];
const failures: string[] = [];

try {
	procs.push(
		Bun.spawn(
			[
				process.execPath,
				SERVER_ENTRY,
				"--host",
				"127.0.0.1",
				"--port",
				String(serverPort),
				"--no-auth",
				"--db",
				join(tmp, "smoke.db"),
			],
			{ cwd: ROOT, stdout: "ignore", stderr: "inherit" },
		),
		Bun.spawn(
			[
				process.execPath,
				CLIENT_ENTRY,
				"--host",
				"127.0.0.1",
				"--port",
				String(clientPort),
				"--dry-run",
				"--config",
				join(tmp, "config.json"),
				"--log-file",
				join(tmp, "log.json"),
			],
			{ cwd: ROOT, stdout: "ignore", stderr: "inherit" },
		),
	);
	const server = `http://127.0.0.1:${serverPort}`;
	const client = `http://127.0.0.1:${clientPort}`;
	await Promise.all([waitFor(`${server}/healthz`), waitFor(`${client}/`)]);

	console.log(`server ${server}`);
	await check(
		server,
		[...Object.values(SERVER_ROUTES), ...SERVER_EXTRA],
		failures,
	);
	console.log(`client ${client}`);
	await check(client, CLIENT_ROUTES, failures);
} finally {
	for (const proc of procs) proc.kill();
	await Promise.all(procs.map((proc) => proc.exited));
	await rm(tmp, { recursive: true, force: true });
}

if (failures.length) {
	console.error(`\nsmoke FAILED:\n  ${failures.join("\n  ")}`);
	process.exit(1);
}
console.log("\nsmoke OK");
