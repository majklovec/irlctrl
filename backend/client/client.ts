#!/usr/bin/env bun

/*
 * client.ts
 *
 * Detects network interfaces suitable for SRTLA bonding, sets up
 * source-based routing tables, writes the uplinks file required by
 * irlserver/srtla_send, and (optionally) monitors interfaces live —
 * rewriting the uplinks file and signalling srtla_send on change.
 *
 * Modem management mirrors BELABOX/belaUI (ws_nodejs):
 *   - enumeration via ModemManager (mmcli)
 *   - per-modem state, signal quality, operator
 *   - enable/disable/reset/connect/disconnect
 *   - integration into bonding selection + routing
 *
 * The web UI/API is always on (`--host`/`--port`); the role comes from
 * `--role` (default `relay`).
 *
 * Core client files (backend/client/):
 *   args.ts / config.ts   CLI arguments and derived settings
 *   exec.ts         shell command helper (dry-run aware)
 *   state.ts        persistent state (config file) + in-memory process state
 *   modems.ts       ModemManager integration
 *   routing.ts      interface detection, selection, routing, uplinks, monitor
 *   srtlaControl.ts srtla_send control-socket JSON-RPC (low-level)
 *   stream.ts       combined srtla_send + encoder start/stop, autostart
 *
 * Device modules (modules/<id>/, see modules/README.md):
 *   encoder/      pipelines + Belacoder/Ceracoder (process management, bitrate changes)
 *   srtla/        srtla_send process management
 *   eventlog.ts     persistent event log shown in the web UI (--log-file)
 *   methods.ts      WebSocket API methods + dispatch (params.ts: parameter validation)
 *   push.ts         status / stats / log pushes to the local UI and the control server
 *   api.ts          local HTTP server: web UI from frontend/ at / and the API at ws://host:port/ws
 *   remote.ts       outbound WebSocket to a remote control server (same protocol);
 *                   the server itself is server.ts
 *
 * Prefers Bun runtime APIs ($, Bun.file, Bun.serve, Bun.spawn).
 *
 * Roles (--role, sent to the control server as the device type):
 *   relay      receives SRT from an encoder and bonds it out via srtla_send (default)
 *   encoder    belacoder + GStreamer pipeline → SRT to a relay; no routing or modems
 *   combined   belacoder → local srtla_send → bonded uplinks; one Start for both
 *
 * Usage:
 *   bun backend/client/client.ts [--config /path/to/config.json] [--dry-run]
 *   bun backend/client/client.ts --port 8085
 *   bun backend/client/client.ts --role encoder  --pipelines /usr/share/belacoder/pipelines
 *   bun backend/client/client.ts --role combined --pipelines ./pipeline
 *   CONTROL_SERVER_TOKEN=secret bun backend/client/client.ts --remote wss://ctl.example.com/device
 *
 * Reload strategy (default `signal`):
 *   --srtla-reload=signal    send SIGHUP, srtla_send re-reads uplinks file
 *   --srtla-reload=restart   kill and respawn srtla_send (falls back here if
 *                            SIGHUP delivery fails or no pid is known)
 */

import { flag } from "../../shared/args";
import { i18nReady, t } from "../../shared/i18n";
import {
	startModules as startRegistryModules,
	stopModules as stopRegistryModules,
} from "../../shared/registry";
import { startApiServer } from "./api";
import { argv, HAS_RELAY, REMOTE_URL, ROLE } from "./config";
import { flushLog, logEvent } from "./eventlog";
import { startRemote, stopRemote } from "./remote";
import {
	reconfigure,
	startInterfaceMonitor,
	stopInterfaceMonitor,
} from "./routing";
import { srtlaServices } from "./services";
import { runAutostart } from "./stream";

async function main(): Promise<void> {
	// Exit before any module/service boots (CI runs `--help` on the compiled
	// binary to verify it and to record bytecode profiles).
	if (flag("--help") || flag("-h")) {
		console.log(
			"Usage: bun backend/client/client.ts [--config /path/to/config.json] [--dry-run] [--port 8085] " +
				"[--role relay|encoder|combined] [--pipelines /path/to/pipelines] " +
				"[--remote ws://host:port/device] [--remote-token secret]",
		);
		console.log(
			"The token/URL may also come from CONTROL_SERVER_TOKEN / CONTROL_SERVER_URL env vars. See the README for the full option list.",
		);
		process.exit(0);
	}

	await i18nReady;
	console.log(`=== SRTLA Bonding Setup (Bun) — role: ${ROLE} ===\n`);

	const shutdown = async (signal: string) => {
		console.log(`\nReceived ${signal}, shutting down...`);
		// Before stopRemote so the control server still receives it
		logEvent("info", "Service", t("log.stopped_signal", { signal }));
		stopRemote();
		stopRegistryModules(); // modules/<id>/backend.ts stop()s (no-ops for modules that never started)
		await stopInterfaceMonitor();
		await flushLog();
		process.exit(0);
	};

	logEvent("info", "Service", t("log.started", { role: ROLE }));

	// Modules bind their `core` bag at start, and every module capability
	// (srtla/encoder) reads it — so start them before any service call below.
	// Signal handlers come after: a signal while modules start hits the default
	// kill (fine), and keeps shutdown from touching half-bound module `core`.
	await startRegistryModules();
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	if (HAS_RELAY) {
		// 1. Prime routing + write uplinks file
		const result = await reconfigure();
		if (!result.ok) {
			console.error("Initial reconfigure failed:", result.error);
			logEvent(
				"error",
				"Interfaces",
				t("log.reconfigure_failed", { error: result.error }),
			);
			await flushLog();
			process.exit(1);
		}
		console.log(`Initial uplinks: ${result.ips.join(", ")}`);

		// 2. Start srtla_send if requested (uses the file we just wrote)
		await srtlaServices.maybeStartSrtla(argv);

		// 3. Start the monitor (will reload srtla_send on changes); encoders have nothing to watch
		startInterfaceMonitor(srtlaServices.reloadSrtla);
	}

	// 4. Start the local API and, if configured, the remote control link
	await startApiServer();
	if (REMOTE_URL) startRemote();

	// 5. Resume the last stream if autostart is enabled (retries until it succeeds)
	runAutostart();
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
