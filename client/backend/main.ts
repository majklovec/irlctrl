/*
 * The device process: brings up the services and the modules, then waits
 * for a signal. client.ts is the entrypoint that regenerates the manifests
 * (source runs) and imports this.
 */
import { flag } from "../../shared/args";
import { i18nReady, t } from "../../shared/i18n";
import { startApiServer } from "./api";
import { REMOTE_URL, ROLE } from "./config";
import { flushLog, logEvent } from "./eventlog";
import { runAutostart, startModules, stopModules } from "./modules";
import { startRemote, stopRemote } from "./remote";

async function main(): Promise<void> {
	// Exit before any module/service boots (CI runs `--help` on the compiled
	// binary to verify it and to record bytecode profiles).
	if (flag("--help") || flag("-h")) {
		console.log(
			"Usage: bun client/backend/client.ts [--config /path/to/config.json] [--dry-run] [--port 8085] " +
				"[--role <registered-role>] [--remote ws://host:port/device] [--remote-token secret]",
		);
		console.log(
			"Every flag also has an env var counterpart (token/URL: CONTROL_SERVER_TOKEN /" +
				" CONTROL_SERVER_URL) — CLI flag > env var > config file > default." +
				" See the README for the full option list, including the module options.",
		);
		process.exit(0);
	}

	await i18nReady;
	console.log(`=== irlctrl device (Bun) — role: ${ROLE} ===\n`);

	const shutdown = async (signal: string) => {
		console.log(`\nReceived ${signal}, shutting down...`);
		// Before stopRemote so the control server still receives it
		logEvent("info", "Service", t("log.stopped_signal", { signal }));
		stopRemote();
		await stopModules();
		await flushLog();
		process.exit(0);
	};

	logEvent("info", "Service", t("log.started", { role: ROLE }));

	// Modules first (in dependency order); signal handlers after, so a signal
	// during start hits the default kill instead of a half-started module.
	await startModules();
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	await startApiServer();
	if (REMOTE_URL) startRemote();

	// Resume the last run if autostart is enabled (retries until it succeeds)
	runAutostart();
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
