#!/usr/bin/env bun

/*
 * client.ts — the device process.
 *
 * The core brings up the generic services (persistent state, event log, the
 * local web UI / WebSocket API, the outbound control-server link, autostart)
 * and drives the modules discovered in modules/<id>/backend.ts. Everything
 * device-specific — bonding uplinks, modems, srtla_send, the encoder, OBS,
 * sshd — is a module: it parses its own CLI arguments, owns its config
 * sections and answers its own RPC methods (see modules/README.md).
 *
 * The web UI/API is always on (`--host`/`--port`); the role comes from
 * `--role` (default `relay`) and decides which modules serve the box.
 *
 * Core client files (backend/client/):
 *   config.ts       core CLI arguments and derived settings
 *   state.ts        persistent state (config file) — core settings + module sections
 *   modules.ts      module lifecycle: slices, start/stop, RPC ownership, status, setup
 *   module-core.ts  the process-services bag handed to modules
 *   capabilities.ts module-to-module capability bus
 *   methods.ts      core WebSocket API methods + dispatch
 *   push.ts         status / module-event / log pushes to the local UI and the control server
 *   api.ts          local HTTP server: web UI at / and the API at ws://host:port/ws
 *   remote.ts       outbound WebSocket to a remote control server (same protocol)
 *   eventlog.ts     persistent event log shown in the web UI (--log-file)
 *   autostart.ts    resume the last run on service start
 *
 * Usage:
 *   bun backend/client/client.ts [--config /path/to/config.json] [--dry-run]
 *   bun backend/client/client.ts --port 8085 --role combined
 *   CONTROL_SERVER_TOKEN=secret bun backend/client/client.ts --remote wss://ctl.example.com/device
 * Module options (e.g. --pipelines, --srtla-reload) are documented in the README.
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
            "Usage: bun backend/client/client.ts [--config /path/to/config.json] [--dry-run] [--port 8085] " +
                "[--role relay|encoder|combined|obs] [--remote ws://host:port/device] [--remote-token secret]",
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
