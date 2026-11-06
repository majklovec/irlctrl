/*
 * The entrypoints regenerate generated/ before loading the application, so a
 * source run works without the manifests on disk (Docker images, a fresh
 * clone, CI). Pinned by booting both processes and generating compiled UI
 * assets against copies of the tree whose generated/ directory is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
let tree: string;

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

async function waitFor(url: string, proc: ReturnType<typeof Bun.spawn>) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null)
			throw new Error(`process exited with ${proc.exitCode}`);
		try {
			const res = await fetch(url);
			if (res.ok) return res;
		} catch {}
		await Bun.sleep(250);
	}
	throw new Error(`${url} did not come up`);
}

function createSourceTree(): string {
	// a copy of the sources without generated/ (node_modules is shared by symlink)
	const tree = mkdtempSync(join(tmpdir(), "irlctrl-nogen-"));
	expect(existsSync(join(tree, "generated"))).toBe(false);
	for (const dir of [
		"client",
		"server",
		"shared",
		"scripts",
		"i18n",
		// the control server statically serves the overlay_templates
		// documents from the storage dir; the mount crashes at boot without it.
		"assets",
	])
		cpSync(join(projectRoot, dir), join(tree, dir), { recursive: true });
	for (const file of [
		"package.json",
		"tsconfig.json",
		"bunfig.toml",
		"css.d.ts",
	])
		cpSync(join(projectRoot, file), join(tree, file));
	symlinkSync(
		join(projectRoot, "node_modules"),
		join(tree, "node_modules"),
		"dir",
	);
	return tree;
}

beforeAll(() => {
	tree = createSourceTree();
});

afterAll(() => {
	rmSync(tree, { recursive: true, force: true });
});

describe("source runs without generated/", () => {
	test("the asset generator creates page manifests before bundling", () => {
		const assetTree = createSourceTree();
		try {
			const result = Bun.spawnSync(
				[process.execPath, "scripts/gen_control_server_assets.ts"],
				{ cwd: assetTree, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
			);
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			for (const file of ["pages.ts", "pages.server.ts", "frontend-assets.ts"])
				expect(existsSync(join(assetTree, "generated", file)), file).toBe(true);
			const source = readFileSync(
				join(assetTree, "generated", "frontend-assets.ts"),
				"utf8",
			);
			expect(source.includes('"dashboard_list":'), "embedded dashboard page").toBe(true);
		} finally {
			rmSync(assetTree, { recursive: true, force: true });
		}
	}, 30_000);

	test("the control server regenerates the manifests and serves its pages", async () => {
		const port = await freePort();
		const proc = Bun.spawn(
			[
				process.execPath,
				"server/main.ts",
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--no-auth",
				"--db",
				join(tree, "x.db"),
			],
			{ cwd: tree, stdout: "ignore", stderr: "pipe" },
		);
		try {
			await waitFor(`http://127.0.0.1:${port}/healthz`, proc);
			expect(existsSync(join(tree, "generated", "overlay_schemas.ts"))).toBe(
				true,
			);
			for (const path of ["/", "/dashboards/", "/overlays/", "/api/overlays"])
				expect(
					(await fetch(`http://127.0.0.1:${port}${path}`)).status,
					path,
				).toBe(200);
		} finally {
			proc.kill();
			await proc.exited;
		}
	}, 90_000);

	test("the device client regenerates the manifests and serves its pages", async () => {
		const port = await freePort();
		const proc = Bun.spawn(
			[
				process.execPath,
				"client/backend/client.ts",
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--dry-run",
				"--config",
				join(tree, "config.json"),
				"--log-file",
				join(tree, "log.json"),
			],
			{ cwd: tree, stdout: "ignore", stderr: "pipe" },
		);
		try {
			await waitFor(`http://127.0.0.1:${port}/`, proc);
			expect((await fetch(`http://127.0.0.1:${port}/settings/`)).status).toBe(
				200,
			);
		} finally {
			proc.kill();
			await proc.exited;
		}
	}, 90_000);
});
