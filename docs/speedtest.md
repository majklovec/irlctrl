# Speedtest module

Runs [librespeed-cli](https://github.com/librespeed/speedtest-cli) against a
LibreSpeed server and streams the results to the device card. The card shows
the live phase (ping / download / upload), cumulative Mbps, a per-second
sparkline, and the last result. **Results are kept in memory only — a restart
clears them. No history is stored.**

Spec: [`TODO/speedtest.md`](../TODO/speedtest.md).

## Binary resolution

The binary is **not** committed. Resolution order:

1. `LIBRESPEED_CLI_PATH` env var (or `--speedtest-cli` CLI flag) — an absolute
   path, or a name resolved on `PATH`.
2. The module data dir (`SPEEDTEST_DIR`, default
   `<tmpdir>/librespeed/librespeed-cli`) — a copy downloaded earlier.
3. `librespeed-cli` next to the app (current working directory) — a
   checked-out build.
4. `librespeed-cli` on `PATH`.
5. Auto-download: the latest release from the GitHub API, asset selected by
   `uname -m` (`x86_64`→`amd64`, `i686`/`i386`→`386`, `aarch64`→`arm64`,
   `armv7l`/`armv8l`→`armv7`, `armv6l`→`armv6`).

The resolved binary is **probed** (`--help` must mention `--json-stream`).
The newest release (v1.0.14) predates that flag — it exists in master builds
only — so a stale binary is rejected up front with a diagnostic naming the
path, instead of dying mid-run with an unparsable
`flag provided but not defined`. Downloads and extraction are single-flight;
the binary is marked `0755`.
On startup, stale children of a previous irlctrl process are killed (a
`/proc` env scan for `IRLCTRL_SPEEDTEST=1`, which the module sets on every
spawn).

## Server list

- Fetched from `https://librespeed.org/backend-servers/servers.php` (10 s
  timeout), the **raw array** persisted verbatim to
  `<SPEEDTEST_DIR>/servers.json` (atomic temp+rename) — that file is the
  CLI's `--local-json` input.
- 1 h TTL: an expired cache is served while a single background refresh runs.
  A failed refresh falls back to the stale cache; with no cache at all the
  list is `available: false` and the card offers only **Auto**.

## CLI argv (single source of truth: `argv.ts`)

`--json-stream` is always first. Optional flags, in this order:

| condition | flag |
| --- | --- |
| `servers.json` exists on disk | `--local-json <path>` |
| a server is selected | `--server <id>` (integer) |
| an interface is selected | `--interface <name>` |
| duration override | `--duration <s>` |

So: no selection + no cache → `--json-stream` only (the CLI picks a random
server and interface); a server without a cache → `--server` without
`--local-json` (the CLI fetches the list itself). A selected server id that is
not in the current cache is rejected with **409 `server_not_in_list`** — no
spawn.

## Runs

- Single-flight: a second start while one runs → **409
  `already_running`**.
- `speedtest.run` event (retained): one envelope per parsed CLI NDJSON line —
  `phase`, `progress`, `result` — plus a synthetic `error` (cancel/failure)
  and a final `exit`; `result` always precedes `exit`.
- Cancel → SIGTERM (→ SIGKILL after 3 s); the hard timeout is
  `duration × 3 + 30 s` (15 s floor on the duration).
- Last result: in memory (`lastResult`), served by `speedtest.last`, cleared
  on restart.

## RPC methods

`speedtest.servers` (optionally `refresh: true`), `speedtest.interfaces`,
`speedtest.run` (`serverId` / `interface` / `duration`), `speedtest.cancel`
(`runId`), `speedtest.last`, `speedtest.saveSettings`.
