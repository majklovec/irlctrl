#!/usr/bin/env bun

/*
 * client.ts — the device process.
 *
 * The core brings up the generic services (persistent state, event log, the
 * local web UI / WebSocket API, the outbound control-server link, autostart)
 * and drives the modules discovered in client/modules/<id>/backend.ts.
 * Everything device-specific is a module: it parses its own CLI arguments,
 * owns its config sections and answers its own RPC methods (see
 * client/modules/README.md). The core names no module.
 *
 * The web UI/API is always on (`--host`/`--port`); the role comes from
 * `--role` (default: the role a module marks `default`) and decides which
 * modules serve the box.
 *
 * Core client files (client/backend/):
 *   main.ts         the process: services, modules, signal handling
 *   config.ts       core CLI arguments and derived settings
 *   state.ts        persistent state (config file) — core settings + module sections
 *   modules.ts      module lifecycle: slices, start/stop, RPC ownership, status, setup
 *   module_core.ts  the process-services bag handed to modules
 *   capabilities.ts module-to-module capability bus
 *   methods.ts      core WebSocket API methods + dispatch
 *   push.ts         status / module-event / log pushes to the local UI and the control server
 *   api.ts          local HTTP server: web UI at / and the API at ws://host:port/ws
 *   remote.ts       outbound WebSocket to a remote control server (same protocol)
 *   eventlog.ts     persistent event log shown in the web UI (--log-file)
 *   autostart.ts    resume the last run on service start
 *
 * Usage:
 *   bun client/backend/client.ts [--config /path/to/config.json] [--dry-run]
 *   bun client/backend/client.ts --port 8085 --role <role>
 *   CONTROL_SERVER_TOKEN=secret bun client/backend/client.ts --remote wss://ctl.example.com/device
 * Module options are documented in the README.
 */
import { ensureGeneratedManifests } from "../../shared/generated_manifests";

// generated/ first: the application graph statically imports the manifests.
await ensureGeneratedManifests();
// Persistent-device safety net: a stray uncaught error — most often a native
// network error surfaced without a JS stack (e.g. a UDP errqueue
// ECONNREFUSED) — logs with full context and lets the process continue
// instead of dying. This is a last-resort backstop; the real fix is the
// per-socket `error` handler in udp_relay (relay.ts / virtual_interface.ts),
// which consumes network errors at the source.
process.on("unhandledRejection", (reason: unknown) => {
    console.error(
        "[unhandledRejection]",
        reason instanceof Error
            ? `${reason.message}\n${reason.stack}`
            : String(reason),
    );
});
process.on("uncaughtException", (err: unknown) => {
    console.error(
        "[uncaughtException]",
        err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
    );
});
await import("./main");
