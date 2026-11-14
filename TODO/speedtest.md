# Handoff: LibreSpeed Speedtest Module for `irlctrl`

**Audience:** An AI coding agent (or human) implementing the feature in https://github.com/majklovec/irlctrl
**Status:** Ready for implementation
**This is the consolidated final version** — it supersedes all earlier revisions.

---

## 0. Summary of decisions

| Decision              | Value                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Result persistence    | ❌ **None.** Results live in memory only; cleared on `irlctrl` restart.                                         |
| Auto-run / scheduling | ❌ **None.** Manual "Run test" only.                                                                            |
| Server selection      | ✅ Download `servers.php`, show searchable dropdown, pass **`--server <id>`** to the CLI.                       |
| Interface selection   | ✅ Enumerate host interfaces, show dropdown, pass `--interface <name>`.                                         |
| Server-list cache     | ✅ Kept (1 h TTL) — network-efficiency cache, **not** a result store. Used for `--local-json` and the dropdown. |
| Target architectures  | ✅ x86_64 **and** ARM (armv6l, armv7l, aarch64).                                                                |
| Realtime transport    | Reuse the app's existing WS/SSE channel; SSE if none exists.                                                    |
| Card placement        | Existing dashboard card pattern — no new page.                                                                  |

---

## 1. Objective

Add a **speedtest module** to `irlctrl` that:

1. **Downloads the official LibreSpeed server list** from `https://librespeed.org/backend-servers/servers.php` and lets the user pick a **specific server** by ID.
2. **Enumerates network interfaces** on the host and lets the user pick which one to bind the test to (e.g. `wwx001e101f0000`).
3. Runs `librespeed-cli` with `--json-stream --local-json <cache> --server <id> --interface <name>`.
4. Parses the streaming NDJSON output in real time on the backend.
5. Pushes each event to the browser via the app's realtime transport.
6. Renders a **single UI card** with live phase, progress, current Mbps, and the final summary.
7. Keeps the **last result in memory only** — no DB, no files, no history.

Primary use case: `irlctrl` manages a cellular modem (x86_64 or ARM); the user manually verifies link health against a chosen LibreSpeed server.

---

## 2. First task for the implementer

You **do not have visibility into `irlctrl`'s codebase yet.** Before coding:

1. Clone/inspect https://github.com/majklovec/irlctrl.
2. Determine and note down:
    - Backend language & framework.
    - Frontend framework & tooling.
    - How existing dashboard "cards" are structured — copy that pattern.
    - How modules are registered / routed.
    - How realtime data is delivered (WS / SSE / polling).
    - How settings persist (JSON file / SQLite / env / none).
    - API conventions (prefix, auth, error envelope).
    - Test setup.
3. Post a short implementation plan in the PR naming the files you'll touch, then implement.

**If the repo is empty or the stack is ambiguous**, default to **Node.js (Express) + React** and state that assumption in the PR.

---

## 3. CLI tool — ground truth

`librespeed-cli` (https://github.com/librespeed/speedtest-cli) — Go binary, official LibreSpeed CLI.

### 3.1 Flags we use

| Flag                  | Purpose                                                         | When                                       |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| `--json-stream`       | Emit NDJSON events on stdout. **Required.**                     | Always                                     |
| `--local-json <path>` | Use a local server-list JSON file instead of fetching remotely. | Whenever our cache file exists.            |
| `--server <id>`       | Test against the server with this **numeric ID** from the list. | When the user picked a specific server.    |
| `--interface <name>`  | Bind traffic to a specific network interface.                   | When the user picked a specific interface. |
| `--duration <sec>`    | Override phase duration (default 15 s).                         | Optional.                                  |

**`--server` takes an integer ID, not a name or URL.**

-   ✅ `--server 105`
-   ❌ `--server "Frankfurt, Germany (FS IT-Systeme GmbH)"`
-   ❌ `--server https://speed.fs-it.systems/`

If the ID is not found in the list currently in use, the CLI exits non-zero with `Server not found` — the backend must surface this as an `error` event (§8).

**Why pass `--local-json`:** without it the CLI re-downloads `servers.php` on every run before the ping phase begins — on a flaky cellular link that pre-flight fetch is the most likely failure point. With `--local-json`, the CLI starts instantly against our cache and we control the refresh timing.

### 3.2 NDJSON output format (verified against real output)

**Phase event:**

```json
{"event":"phase","phase":"ping"}
{"event":"phase","phase":"download"}
{"event":"phase","phase":"upload"}
```

**Progress event** (download/upload only, ~1 Hz):

```json
{"event":"progress","phase":"download","seconds":1,"mbps":10.71,"progress":6}
{"event":"progress","phase":"download","seconds":15,"mbps":5.13,"progress":100}
```

| Field      | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `phase`    | `"download"` or `"upload"`                                     |
| `seconds`  | elapsed seconds in phase (1-based)                             |
| `mbps`     | **cumulative average** since phase start — _not_ instantaneous |
| `progress` | 0–100 integer, phase completion %                              |

**Result event** (once, at end):

```json
{"event":"result","reports":[{ … }]}
```

Report object:

```json
{
    "timestamp": "2026-11-14T07:05:11.038780336+01:00",
    "server": {
        "name": "Frankfurt, Germany (FS IT-Systeme GmbH)",
        "url": "https://speed.fs-it.systems/"
    },
    "client": {
        "ip": "46.135.89.151",
        "hostname": "",
        "city": "",
        "region": "",
        "country": "CZ",
        "loc": "",
        "postal": "",
        "timezone": "",
        "org": "Vodafone Czech Republic a.s."
    },
    "bytes_sent": 524288,
    "bytes_received": 10010624,
    "ping": 31.46,
    "jitter": 6.25,
    "upload": 0.27,
    "download": 5.13,
    "share": "",
    "tls": { "version": "TLS 1.3", "cipher": "TLS_CHACHA20_POLY1305_SHA256" }
}
```

### 3.3 Process behavior

-   Exit `0` on success; non-zero + stderr on failure.
-   Output is newline-delimited; **a partial trailing line can arrive** — buffer input and discard the incomplete tail on exit.
-   Non-JSON noise (banner lines) may appear on stdout — skip lines that fail `JSON.parse`, log at debug level.

---

## 4. Requirements — functional

### 4.1 Server selection

1. Backend exposes a server list (cached — §6.4).
2. UI shows a **searchable dropdown**: label = `name`, subtitle = `sponsor`.
3. First option is always **"Auto (let the CLI choose)"** → `serverId: null`.
4. Persist the last selection (`{id, name}`) in the app's existing settings store; if none exists, use frontend `localStorage`.
5. If the stored ID is not in the fresh list → clear it, prompt to re-select.
6. If the list fetch fails and no cache exists → hide specific-server selection, show only "Auto", display a dismissible warning.

### 4.2 Interface selection

1. Enumerate host interfaces (§6.5) and expose in a dropdown.
2. Persist the last selection alongside the server.
3. Include **"Auto (no binding)"** → `interface: null` (omit `--interface`).
4. Non-Linux: either hide the dropdown or populate per-OS (§9.9).

### 4.3 Test execution

1. **Run test** button — disabled while a test is running.
2. Spawn argv per §5.1 (truth table).
3. **Live view** (≤1 s latency):
    - phase label (ping / download / upload),
    - progress bar from `progress`,
    - current `mbps`,
    - optional instantaneous-throughput sparkline (§7.3).
4. **Summary** on `result`:
    - download / upload (Mbps, 2 dp), ping / jitter (ms, 2 dp),
    - server name + sponsor, client IP + org, TLS version/cipher,
    - timestamp, chosen interface + server ID.
5. **In-memory last result** — backend holds the last successful result. `GET /api/speedtest/last` returns it after a page reload. **No persistence**; restarting `irlctrl` clears it.
6. **Cancel** — `SIGTERM`, emit synthetic `error` + `exit`.
7. **Single-flight** — second Run returns `409 Conflict`.
8. **Error surface** — non-zero exit or parse failure shown in the card; future runs unaffected.

### 4.4 Card placement

Follow existing dashboard card conventions — **no separate page**.

---

## 5. Requirements — argv construction & binary management

### 5.1 Argv construction — the one and only rule

```
librespeed-cli --json-stream
              [--local-json <cachePath>]     // iff cache file exists
              [--server <serverId>]          // iff user picked a specific server
              [--interface <ifaceName>]      // iff user picked a specific interface
```

**Never filter, subset, or rewrite the server-list file per run.** The whole cached list is written once on refresh and reused as-is. The specific choice is communicated **only** via `--server <id>`.

#### Truth table — implement directly as a parametrized test

| `serverId` | `interface`       | cache exists | Resulting argv (after `librespeed-cli`)                                                   |
| ---------- | ----------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `105`      | `wwx001e101f0000` | yes          | `--json-stream --local-json ./data/servers.json --server 105 --interface wwx001e101f0000` |
| `105`      | `null`            | yes          | `--json-stream --local-json ./data/servers.json --server 105`                             |
| `null`     | `wwx001e101f0000` | yes          | `--json-stream --local-json ./data/servers.json --interface wwx001e101f0000`              |
| `null`     | `null`            | yes          | `--json-stream --local-json ./data/servers.json`                                          |
| `105`      | `wwx001e101f0000` | **no**       | `--json-stream --server 105 --interface wwx001e101f0000`                                  |
| `105`      | `null`            | **no**       | `--json-stream --server 105`                                                              |
| `null`     | any               | **no**       | `--json-stream [--interface …]`                                                           |

#### Consistency check before spawning

If `serverId` is non-null but the current cache is missing that ID (server retired on refresh): **do not spawn**. Return `409` with `{ "error": "server_not_in_list", "serverId": 105 }`. The UI clears the selection and prompts to re-pick.

If `serverId` is non-null but no cache file exists (offline first-run): still pass `--server 105` **without** `--local-json` — the CLI will fetch the remote list and resolve the ID itself.

#### Atomic cache writes

Refresh must write `servers.json.tmp` then `fs.renameSync(tmp, final)`. POSIX rename is atomic, so a spawn either sees the old file or the new one, never a partial one.

### 5.3 Process & resource hygiene

-   Spawn async — no blocking the main event loop.
-   **Cleanup** — kill the child on shutdown, cancel, and client disconnect (§9.5). Tag children with `IRLCTRL_SPEEDTEST=1` in their env; on startup, kill stale orphans matching that tag.
-   **Logging** — raw NDJSON → rotating debug log. Do not log full client IPs to normal logs.
-   **Timeout** — hard-kill the child at `duration × 3 + 30 s` (default ≈ 75 s) if it hasn't exited.

---

## 6. Architecture

```
┌──────────────────┐
│ librespeed.org   │  HTTPS GET (servers.php)       ┌─────────────────────┐
│ /servers.php     │ ─────────────────────────────► │  server-list cache  │
└──────────────────┘                                │  (TTL 1h, NOT a DB) │
                                                    └─────────┬───────────┘
                                                              │
┌──────────────┐  NDJSON on stdout   ┌──────────────────────┐ │   WS / SSE  ┌────────────┐
│ librespeed-  │ ──────────────────► │  backend module      │◄┘────────────►│  browser   │
│ cli (child)  │  (--local-json …)   │  spawn + parse +     │               │  card      │
└──────────────┘                     │  broadcast + last    │               └────────────┘
                                     │  result in memory    │
                                     └──────────────────────┘
```

### 6.1 REST / realtime contract

| Method   | Path                               | Purpose                                                                                          |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/speedtest/servers?refresh=1` | Cached server list; `refresh=1` forces re-download.                                              |
| `GET`    | `/api/speedtest/interfaces`        | `{ "interfaces": [{ "name":"wwx001e101f0000", "addresses":["10.0.0.2"], "up":true }, …] }`       |
| `POST`   | `/api/speedtest/run`               | Body `{ "interface": "…"\|null, "serverId": 105\|null }` → `202 { "runId": "<uuid>" }` or `409`. |
| `DELETE` | `/api/speedtest/run/:runId`        | Cancel; `204`.                                                                                   |
| `GET`    | `/api/speedtest/stream?runId=<id>` | SSE stream (§6.2).                                                                               |
| `GET`    | `/api/speedtest/last`              | **In-memory** last result, or `204` if none since process start.                                 |

No history endpoints.

### 6.2 SSE event envelope

```json
{"runId":"…","kind":"phase","data":{"event":"phase","phase":"download"}}
{"runId":"…","kind":"progress","data":{"event":"progress","phase":"download","seconds":3,"mbps":7.49,"progress":20}}
{"runId":"…","kind":"result","data":{"event":"result","reports":[{…}]}}
{"runId":"…","kind":"error","data":{"message":"…","exitCode":1,"stderrTail":"…"}}
{"runId":"…","kind":"exit","data":{"code":0}}
```

Send `kind:"result"` **before** `kind:"exit"`.

### 6.3 In-memory last result

```js
let lastResult = null;
// { runId, interface, serverId, serverName, startedAt, finishedAt, result }
```

Overwritten on each successful run; cleared on restart. Returned by `GET /api/speedtest/last`.

**No DB, no file, no history.**

### 6.4 Server list — download, parse, cache

**Source:** `https://librespeed.org/backend-servers/servers.php`
**Format:** JSON array. Verified sample entry:

```json
{
    "name": "Frankfurt, Germany (FS IT-Systeme GmbH)",
    "server": "https://speed.fs-it.systems/",
    "id": 105,
    "dlURL": "backend/garbage.php",
    "ulURL": "backend/empty.php",
    "pingURL": "backend/empty.php",
    "getIpURL": "backend/getIP.php",
    "sponsorName": "FS IT-Systeme GmbH",
    "sponsorURL": "https://go.bytevault.systems/fsit-web-spd1"
}
```

**Backend behavior:**

1. `GET` with 10 s timeout, `Accept: application/json`.
2. Parse as JSON array; require numeric `id`, string `name`, string `server`. Drop malformed entries; do not fail the whole list.
3. Persist the **raw JSON array** to `./data/servers.json` via temp-file + atomic rename — this is what gets passed to `--local-json`.
4. Expose a **normalized view** for the UI:
    ```json
    {
        "id": 105,
        "name": "Frankfurt, Germany (FS IT-Systeme GmbH)",
        "sponsor": "FS IT-Systeme GmbH",
        "url": "https://speed.fs-it.systems/"
    }
    ```
5. **1-hour TTL.** Serve from cache; refresh in background on expiry. Manual refresh button in UI.
6. If fetch fails **and** no cache exists: return `{ "available": false, "servers": [] }`. UI shows only "Auto" + warning.

**Do not use `--server-json`** — it makes the CLI re-download the list every run.

### 6.5 Interface enumeration

**Linux (primary target incl. ARM SBCs / WWAN routers):**

-   Read `/sys/class/net/` to list **all** interfaces (Node's `os.networkInterfaces()` hides ones without an address).
-   Join with `os.networkInterfaces()` for IPv4/IPv6 addresses + MAC.
-   Return `{ name, addresses: string[], up: boolean }`.
-   Exclude `lo` from default selection, keep it in the list.
-   Default: first `up` non-loopback interface with an IPv4 address.

**Fallback (non-Linux / `/sys/class/net` missing):** `os.networkInterfaces()` keys with `up: true` heuristic.

**Windows/macOS:** names differ (`Ethernet`, `en0`, …). Enumerate via `os.networkInterfaces()`; consider hiding the dropdown in v1.

---

## 7. Frontend card — detailed spec

### 7.1 States

| State            | UI                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| idle             | Run button; **server** + **interface** dropdowns; "Refresh servers" link; last result (from `/last`) if any |
| running-ping     | spinner + "Ping…" (indeterminate; ping emits no progress)                                                   |
| running-download | progress bar 0–100 %, big `mbps`, phase label                                                               |
| running-upload   | same, different accent color                                                                                |
| done             | summary + "Run again"                                                                                       |
| error            | red banner + "Retry" (preserves selections)                                                                 |

### 7.2 Layout sketch

```
┌─────────────────────────────────────────────────────────────┐
│  Speedtest                                                  │
│  Server   [ Frankfurt, Germany (FS IT-Systeme GmbH)    ▾ ]  │
│  Interface[ wwx001e101f0000 (10.0.0.2)                 ▾ ]  │
│                                            [Run test]       │
├─────────────────────────────────────────────────────────────┤
│  Phase: DOWNLOAD          Current: 7.49 Mbps                │
│  ████████████░░░░░░░░░░░░░░░░░  20%                         │
│  (optional sparkline)                                       │
├─────────────────────────────────────────────────────────────┤
│  ⬇ 5.13 Mbps   ⬆ 0.27 Mbps   ping 31.5 ms / jitter 6.3 ms  │
│  Frankfurt, DE · FS IT-Systeme GmbH · Vodafone CZ · TLS 1.3│
│  2026-11-14 07:05 · iface wwx001e101f0000                   │
└─────────────────────────────────────────────────────────────┘
```

### 7.3 Instantaneous vs. cumulative Mbps

CLI `mbps` is a cumulative average and visibly decays (10.71 → 5.13 in the sample). Show cumulative as the primary number; compute instantaneous for the sparkline:

```js
const cumMegaBits = mbps * seconds;
const instMbps = (cumMegaBits - prevCumMegaBits) / (seconds - prevSeconds);
// clamp negative / NaN → 0
```

### 7.4 Accessibility / robustness

-   `aria-live="polite"` on the phase label.
-   `EventSource.onerror` → auto-reconnect.
-   Searchable server dropdown (50+ entries).

---

## 8. Error handling

Server-specific:

1. **`Server not found` from CLI** → `kind:"error"` with `{ "message": "Selected server is no longer available", "stderrTail": "…" }`. No auto-retry, no fallback — user chooses explicitly.
2. **`--server` given, no valid list available** (no cache + CLI's own fetch fails) → `{ "message": "Server list unavailable; pick 'Auto' to let the CLI choose" }`.
3. **Stale server ID** (not in current cache) → `409 server_not_in_list`, **no spawn** (§5.1).
4. **Refresh race** → atomic rename guarantees the child sees a complete file (§5.1).

General (from prior revisions): 5. **Server-list fetch fails** → cached copy if present; else hide server selection, warning banner. 6. **Stored ID not in refreshed list** → clear selection, prompt. 7. **Interface missing / no address** → CLI exits non-zero; surface stderr. 8. **No internet / server unreachable** → error card; do not set `lastResult`. 9. **Client closes tab mid-run** → after last SSE subscriber disconnects, cancel child after 5 s grace. 10. **Server restart during run** → kill stale `IRLCTRL_SPEEDTEST=1` children on startup. 11. **Two runs** → `409`, no queue. 12. **Partial JSON line at exit** → strip. 13. **Non-Linux** → names differ; don't break the module. 14. **Binary download fails** → clear error with release URL + detected arch. 15. **`servers.php` returns malformed JSON** → treat as fetch failure; never pass malformed JSON to `--local-json`. 16. **`--local-json` path with spaces** → quote correctly. 17. **32-bit ARM mismatch** → detect via `uname -m`; on SIGILL at startup surface detected arch + manual-install instructions.

---

## 9. Testing plan

### Unit

-   **Server-list parser** — fixture with valid + malformed entries; drops the bad one.
-   **Cache TTL** — mocked clock; refetch after 1 h, not before.
-   **Interface enumeration** — mock `/sys/class/net` + `os.networkInterfaces()`; `wwx001e101f0000` appears with its address.
-   **ARM asset mapping** — table test: `{x86_64→amd64, i686→386, aarch64→arm64, armv8l→armv7l, armv7l→armv7l, armv6l→armv6l, unknown-arm→fail}`. Include the case `process.arch === 'arm'` + `uname -m === 'armv6l'` → **armv6** asset (not armv7).
-   **NDJSON parser** — §12.1 fixture → 3 phase + 30 progress + 1 result, 0 errors. Partial trailing line → dropped. Garbage → skipped.
-   **Instantaneous Mbps** — against §12.1 sample (downward trend).

### Integration

-   **Argv truth table** — parametrized over §5.1 (this is the single most important test).
-   **Stale server ID** — cache has `[79, 105]`, request `serverId: 999` → `409 server_not_in_list`, no child spawned.
-   **Missing cache + server picked** — no `./data/servers.json`, `serverId: 105` → argv has `--server 105`, no `--local-json`.
-   **Refresh race** — start refresh, immediately Run; assert child sees old or new file, never truncated (mock `fs`).
-   **Cancel** — SIGTERM → subscriber gets `error` then `exit`.
-   **Double-run** — second POST → `409`.
-   **`GET /api/speedtest/last`** — `204` before any run; returns last result after success; overwritten by subsequent run.
-   **No persistence** — restart backend → `GET /last` returns `204`.
-   **Live CLI** (optional, gated by `INTEGRATION_SPEEDTEST=1`) — run against a known server ID; assert exit `0` and `result.server.name` matches.

### Frontend

-   Snapshots: idle (dropdowns populated) / running / done / error — mocked `EventSource`.

### Manual

-   On the user's machine: Frankfurt (id 105) + `wwx001e101f0000`, live updates verified.
-   On the **ARM device**: confirm the correct binary is downloaded and the interface list looks sane.

---

## 10. Acceptance criteria

-   [ ] New "Speedtest" card on the dashboard, matching existing card styling.
-   [ ] **Searchable server dropdown** from `servers.php` (cached, manual refresh).
-   [ ] **Interface dropdown** from the host, includes `wwx001e101f0000` when present.
-   [ ] Selections persist across reloads (existing settings store or `localStorage`).
-   [ ] "Run" spawns the CLI per §5.1 and streams live updates ≥ 1 Hz.
-   [ ] Summary shows download, upload, ping, jitter, server name + sponsor, client IP/org, TLS, chosen interface, timestamp.
-   [ ] Server list unavailable + no cache → card still works via CLI auto-select + warning.
-   [ ] **Chosen server reaches the CLI only via `--server <id>`**; the cached list file is never modified per-run.
-   [ ] **Argv truth table (§5.1) covered by parametrized test and passing.**
-   [ ] **Stale server ID → clean `409 server_not_in_list`, no spawn.**
-   [ ] **"Auto" omits `--server` entirely.**
-   [ ] **No persistence** of results — no DB writes, no result files. Restart clears `lastResult`.
-   [ ] `GET /api/speedtest/last` returns in-memory result after a run, `204` after restart.
-   [ ] Cancel works, no orphan child.
-   [ ] Errors display without page reload.
-   [ ] **ARM supported** — armv6l / armv7l / aarch64 assets resolve and execute; SIGILL at startup surfaces a clear diagnostic naming the detected arch.
-   [ ] No regressions; new tests cover the list above.
-   [ ] Binary **not** committed; resolves via `LIBRESPEED_CLI_PATH` / `PATH` / auto-download.

---

## 11. Open questions (defaults in parens)

1. **Transport** — SSE vs. existing WS? _(default: reuse existing; else SSE)_
2. **Settings store for selections** — reuse existing; else `localStorage`. _(default: reuse existing)_
3. **Server dropdown UX** — flat searchable vs. grouped by country? _(default: flat, searchable)_
4. **Multi-interface runs** — out of scope v1; TODO note.
5. **`--local-json`** — keep (cache) vs. drop and always fetch remote? _(default: keep; see §3.1 for rationale)_

---

## 12. Fixtures

### 12.1 `fixtures/speedtest-sample.ndjson`

```ndjson
{"event":"phase","phase":"ping"}
{"event":"phase","phase":"download"}
{"event":"progress","phase":"download","seconds":1,"mbps":10.71,"progress":6}
{"event":"progress","phase":"download","seconds":2,"mbps":8.51,"progress":13}
{"event":"progress","phase":"download","seconds":3,"mbps":7.49,"progress":20}
{"event":"progress","phase":"download","seconds":4,"mbps":6.92,"progress":26}
{"event":"progress","phase":"download","seconds":5,"mbps":6.53,"progress":33}
{"event":"progress","phase":"download","seconds":6,"mbps":6.31,"progress":40}
{"event":"progress","phase":"download","seconds":7,"mbps":6.14,"progress":46}
{"event":"progress","phase":"download","seconds":8,"mbps":5.91,"progress":53}
{"event":"progress","phase":"download","seconds":9,"mbps":5.88,"progress":60}
{"event":"progress","phase":"download","seconds":10,"mbps":5.8,"progress":66}
{"event":"progress","phase":"download","seconds":11,"mbps":5.72,"progress":73}
{"event":"progress","phase":"download","seconds":12,"mbps":5.63,"progress":80}
{"event":"progress","phase":"download","seconds":13,"mbps":5.59,"progress":86}
{"event":"progress","phase":"download","seconds":14,"mbps":5.48,"progress":93}
{"event":"progress","phase":"download","seconds":15,"mbps":5.13,"progress":100}
{"event":"phase","phase":"upload"}
{"event":"progress","phase":"upload","seconds":1,"mbps":2.61,"progress":6}
{"event":"progress","phase":"upload","seconds":2,"mbps":1.61,"progress":13}
{"event":"progress","phase":"upload","seconds":3,"mbps":1.16,"progress":20}
{"event":"progress","phase":"upload","seconds":4,"mbps":0.91,"progress":26}
{"event":"progress","phase":"upload","seconds":5,"mbps":0.75,"progress":33}
{"event":"progress","phase":"upload","seconds":6,"mbps":0.63,"progress":40}
{"event":"progress","phase":"upload","seconds":7,"mbps":0.55,"progress":46}
{"event":"progress","phase":"upload","seconds":8,"mbps":0.49,"progress":53}
{"event":"progress","phase":"upload","seconds":9,"mbps":0.44,"progress":60}
{"event":"progress","phase":"upload","seconds":10,"mbps":0.4,"progress":66}
{"event":"progress","phase":"upload","seconds":11,"mbps":0.36,"progress":73}
{"event":"progress","phase":"upload","seconds":12,"mbps":0.33,"progress":80}
{"event":"progress","phase":"upload","seconds":13,"mbps":0.31,"progress":86}
{"event":"progress","phase":"upload","seconds":14,"mbps":0.29,"progress":93}
{"event":"progress","phase":"upload","seconds":15,"mbps":0.27,"progress":100}
{"event":"result","reports":[{"timestamp":"2026-11-14T07:05:11.038780336+01:00","server":{"name":"Frankfurt, Germany (FS IT-Systeme GmbH)","url":"https://speed.fs-it.systems/"},"client":{"ip":"46.135.89.151","hostname":"","city":"","region":"","country":"CZ","loc":"","org":"Vodafone Czech Republic a.s.","postal":"","timezone":""},"bytes_sent":524288,"bytes_received":10010624,"ping":31.46,"jitter":6.25,"upload":0.27,"download":5.13,"share":"","tls":{"version":"TLS 1.3","cipher":"TLS_CHACHA20_POLY1305_SHA256"}}]}
```

Expected: **3 phase, 30 progress, 1 result, 0 errors.**

### 12.2 `fixtures/servers-sample.json`

```json
[
    {
        "name": "Frankfurt, Germany (FS IT-Systeme GmbH)",
        "server": "https://speed.fs-it.systems/",
        "id": 105,
        "dlURL": "backend/garbage.php",
        "ulURL": "backend/empty.php",
        "pingURL": "backend/empty.php",
        "getIpURL": "backend/getIP.php",
        "sponsorName": "FS IT-Systeme GmbH",
        "sponsorURL": "https://go.bytevault.systems/fsit-web-spd1"
    },
    {
        "name": "Prague, Czech Republic (CESNET)",
        "server": "https://speedtest.cesnet.cz/",
        "id": 79,
        "dlURL": "backend/garbage.php",
        "ulURL": "backend/empty.php",
        "pingURL": "backend/empty.php",
        "getIpURL": "backend/getIP.php",
        "sponsorName": "CESNET",
        "sponsorURL": "https://www.cesnet.cz"
    }
]
```

---

## 13. Deliverables checklist

-   [ ] Exploration notes in the PR (which files, which patterns).
-   [ ] Backend module:
    -   server-list fetch / cache / normalize / atomic write,
    -   interface enumeration (`/sys/class/net` + fallback),
    -   cross-arch binary resolver + downloader (§5.2) with ARM variant detection,
    -   argv builder per §5.1,
    -   spawn + NDJSON parser + SSE broadcast,
    -   in-memory `lastResult` + `GET /last`.
-   [ ] Frontend card: server dropdown, interface dropdown, live view, summary, error state. **No history UI.**
-   [ ] Fixtures: `fixtures/speedtest-sample.ndjson`, `fixtures/servers-sample.json`.
-   [ ] `docs/` section covering:
    -   `LIBRESPEED_CLI_PATH`,
    -   server-list cache path + TTL,
    -   argv truth table (§5.1),
    -   **results are in-memory only**.
-   [ ] PR description links this doc and checks off §10.
-   [ ] Screenshots/video of idle (dropdowns populated), running, done.
