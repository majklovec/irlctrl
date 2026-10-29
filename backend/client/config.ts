/*
 * Device process settings: the core's CLI arguments (with env / config-file
 * fallbacks) and derived values. Modules parse their own arguments with
 * shared/args.
 *
 * Every setting resolves in the same order: CLI flag > env var > config file
 * > default.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    argEnv,
    argFail,
    argv,
    enumArgEnv,
    flagOrEnv,
    intArgEnv,
} from "../../shared/args";
import { isRole, REMOTE_URL_RE, ROLES, type Role } from "../../shared/validate";

export { argv, ROLES, type Role };

const TMP = tmpdir();

// Device config: the core settings plus every module's own sections; live
// process state is memory-only and never persisted.
export const CONFIG_FILE = argEnv("--config", "CONFIG_FILE", join(TMP, "config.json"));
// A fresh device (no config file) shows the setup wizard first
export const CONFIG_EXISTS = await Bun.file(CONFIG_FILE).exists();
/** Config file contents at startup (null when missing or unreadable); state.ts builds on it. */
export const INITIAL_CONFIG = CONFIG_EXISTS
    ? ((await Bun.file(CONFIG_FILE)
          .json()
          .catch(() => null)) as Record<string, unknown> | null)
    : null;
const persisted = (
    key: "role" | "remoteUrl" | "remoteToken",
): string | undefined => INITIAL_CONFIG?.[key] as string | undefined;

// Event log shown in the web UI
export const LOG_FILE = argEnv("--log-file", "LOG_FILE", join(TMP, "srtla_log.json"));
export const DRY_RUN = flagOrEnv("--dry-run", "DRY_RUN");
export const API_PORT = intArgEnv("--port", "API_PORT", 8085, 1, 65535);
export const API_HOST = argEnv("--host", "API_HOST", "127.0.0.1");
// Extra browser origins allowed to open the WebSocket (comma-separated, `*` = any)
export const ALLOWED_ORIGINS = argEnv("--allow-origin", "ALLOWED_ORIGINS", "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
// Outbound control connection: status is pushed to and requests accepted from this server.
// CLI > env > config file: the env vars (e.g. from docker-compose) override the
// persisted config; an explicit CLI flag still wins over both.
export const REMOTE_URL = argEnv(
    "--remote",
    "CONTROL_SERVER_URL",
    persisted("remoteUrl") ?? "",
);
export const REMOTE_TOKEN = argEnv(
    "--remote-token",
    "CONTROL_SERVER_TOKEN",
    persisted("remoteToken") ?? "",
);
export const REMOTE_INTERVAL = intArgEnv(
    "--remote-interval",
    "CONTROL_SERVER_INTERVAL",
    30,
); // periodic status push, seconds (0 = off)
// Throttled module pushes (e.g. link telemetry) to the control server, seconds (0 = off)
export const REMOTE_STATS_INTERVAL = intArgEnv(
    "--remote-stats-interval",
    "CONTROL_SERVER_STATS_INTERVAL",
    2,
);
if (REMOTE_URL && !REMOTE_URL_RE.test(REMOTE_URL))
    argFail("--remote", REMOTE_URL, "ws:// or wss:// URL");

export const ROLE: Role = enumArgEnv(
    "--role",
    ROLES,
    "ROLE",
    (persisted("role") ?? "relay") as Role,
);
if (!isRole(ROLE)) argFail("ROLE", ROLE, ROLES.join(" | "));
