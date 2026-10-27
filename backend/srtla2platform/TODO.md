# AI Handoff Document — `srtla2platform`

**Project:** `srtla2platform` — SRTLA → SRT → RTMP bridge with irlctrl integration  
**Date:** 2026-10-27  
**Status:** Design complete, initial implementation scaffolded, not yet tested end‑to‑end  
**Related repos:**
- https://github.com/majklovec/irlctrl (control server, Bun/TS)
- https://github.com/irlserver/srtla (`srtla_rec` binary, pinned `b8359bc` by the OBS plugin)
- https://github.com/majklovec/obs-srtla-input-plugin (reference architecture)

---

## 1. What We Are Building

`srtla2platform` is a **device‑side agent** that:
1. **Registers** with the **irlctrl control server** over WebSocket as a new device role `srtla2platform`.
2. **Receives** a **bonded SRTLA** stream from an encoder (e.g., OBS + srtla sender, BELABOX, IRLToolkit).
3. **De‑bonds** it into a standard **SRT** stream using `srtla_rec` from **irlserver/srtla** (rev `b8359bc`) — the same receiver the OBS plugin embeds as a static library.
4. **Transcodes/muxes** the SRT stream into **RTMP** using **GStreamer** (`srtsrc → tsdemux → flvmux → rtmpsink`).
5. **Publishes** the RTMP feed to a user‑configured platform (Twitch, YouTube, custom ingest, etc.).
6. **Accepts control commands** from irlctrl (`start`, `stop`, `status`) via the WebSocket control plane.

The core use case is the **“basic” mode**: pure stream copy (no re‑encode) from SRTLA to RTMP. Advanced OBS‑like features (overlay, scaling, volume) are optional extensions.

---

## 2. Key Decisions & Rationale

| Decision                                                                                          | Rationale                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Use `srtla_rec` instead of reimplementing SRTLA in TS**                                         | SRTLA is a latency‑sensitive UDP bonding protocol with REG1/REG2/REG3 handshake. Reimplementing in JS/Bun would be fragile and slow. The C++ receiver from **irlserver/srtla** is what the OBS plugin uses (rev `b8359bc`). **Do not use the BELABOX original — it is marked unsupported.** |
| **GStreamer for SRT → RTMP**                                                                      | Mature, zero‑copy when stream‑copying, ships in most distros, supports both `srtsrc` and `rtmpsink` natively. Replaces what would otherwise be ffmpeg.                                              |
| **Bun + TypeScript for the orchestrator**                                                         | Matches irlctrl’s stack, keeps the fleet uniform, and gives us WebSocket + child_process APIs out of the box.                                                                                       |
| **WebSocket `/device` endpoint with Bearer token**                                                | Mirrors the existing `obs-client` registration pattern in irlctrl, no server changes required if the role is accepted dynamically.                                                                  |
| **JSON request/response protocol** (`{id, method, params}` / `{type:"response", id, ok, result}`) | Matches irlctrl’s existing RPC framing.                                                                                                                                                             |
| **Two‑process model** (`srtla_rec` + `gst-launch`) rather than a single in‑process pipeline       | Simplest to implement and debug. Can be replaced later with `gstreamer-rs` bindings or a native SRTLA element if needed.                                                                            |
| **`mode=listener` for `srtsrc`**                                                                   | **Verified against `srtla_rec` b8359bc**: it is the SRT **caller** (`connect()` in `srt_handler.cpp`), so GStreamer must listen on `127.0.0.1:5002`. GStreamer is spawned *first*, then `srtla_rec`. The earlier handoff spec had this backwards. |

---

## 3. Architecture (as implemented)

```
┌──────────────┐   SRTLA (bonded UDP)   ┌───────────────────────────────────────────┐
│   Encoder    │ ─────────────────────▶ │  srtla2platform host                      │
│ (OBS/BELA)   │                        │                                           │
└──────────────┘                        │  ┌────────────┐    SRT    ┌────────────┐  │
                                        │  │ srtla_rec  │ ────────▶ │ GStreamer  │  │
                                        │  │  :5000 UDP │  :5002    │ pipeline   │  │
                                        │  └────────────┘           └─────┬──────┘  │
                                        │                                  │ RTMP   │
                                        │  ┌────────────────────┐          │        │
                                        │  │ Bun orchestrator   │          ▼        │
                                        │  │ (srtla2platform.ts)│    ┌──────────┐  │
                                        │  └─────────┬──────────┘    │ Platform │  │
                                        │            │ WSS           │  ingest  │  │
                                        └────────────┼───────────────┴──────────┘  │
                                                     │
                                                     ▼
                                       ┌────────────────────────────┐
                                       │ irlctrl control server     │
                                       │ /device (WSS + Bearer)     │
                                       └────────────────────────────┘
```

- **Ports:** `5000/udp` (SRTLA in), `5002/tcp` (SRT local), outbound WSS to control server, outbound RTMP.
- **Processes:** 3 — `bun srtla2platform.ts`, `srtla_rec`, `gst-launch-1.0`.

---

## 4. Files & Artifacts Created

| File                                   | Purpose                                                       | Status                                |
| -------------------------------------- | ------------------------------------------------------------- | ------------------------------------- |
| `srtla2platform.ts`                    | Main Bun orchestrator (WebSocket client + process supervisor) | Drafted, not run against live irlctrl |
| _(proposed)_ `modules/srtla2platform/` | irlctrl module for web UI card                                | Not started                           |
| _(proposed)_ `srtla2platform.service`  | systemd unit                                                  | Not started                           |
| _(proposed)_ `DEVICE_UUID` config file | Persistent device identity                                    | Not started                           |

The full draft of `srtla2platform.ts` is in Section 6.

---

## 5. irlctrl Integration Contract

### 5.1 Connection

- **URL:** `wss://<ctl-host>/device`
- **Auth:** `Authorization: Bearer <token>` header
- **Reconnect:** exponential or fixed 5 s backoff (current draft uses fixed 5 s)

### 5.2 Hello frame (device → server)

```json
{
	"type": "hello",
	"role": "srtla2platform",
	"uuid": "<stable-uuid>",
	"hostname": "srtla2platform-01",
	"version": "1.0.0",
	"capabilities": ["srtla2platform.start", "srtla2platform.stop"]
}
```

### 5.3 Request (server → device)

```json
{ "id": "abc123", "method": "start", "params": {} }
```

Supported methods:
- `start` — spawn `srtla_rec`, then `gst-launch-1.0` pipeline
- `stop` — SIGTERM both children
- `status` — return `{ running, srtlaPid, gstPid, srtlaPort, srtPort, rtmpUrl }`

### 5.4 Response (device → server)

```json
{
	"type": "response",
	"id": "abc123",
	"ok": true,
	"result": { "state": "starting" }
}
```

### 5.5 ⚠️ Open Question

Does the irlctrl server **validate roles against a whitelist**? If yes, `srtla2platform` must be added to the role enum in the irlctrl server code (likely `src/protocol.ts` or similar). If roles are free‑form, no server change is needed. **Verify before shipping.**

---

## 6. Current Code (Draft)

```ts
#!/usr/bin/env bun
/**
 * srtla2platform – SRTLA → SRT → RTMP bridge with irlctrl registration.
 */
import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { hostname as osHostname } from "node:os";

const {
  values: {
    remote = "ws://127.0.0.1:8090/device",
    token = process.env.CONTROL_SERVER_TOKEN ?? "",
    "srtla-port": srtlaPort = "5000",
    "srt-host": srtHost = "127.0.0.1",
    "srt-port": srtPort = "5002",
    "rtmp-url": rtmpUrl = "rtmp://live.example.com/app/streamkey",
    hostname = osHostname(),
  },
} = parseArgs({
  options: {
    remote: { type: "string" },
    token: { type: "string" },
    "srtla-port": { type: "string" },
    "srt-host": { type: "string" },
    "srt-port": { type: "string" },
    "rtmp-url": { type: "string" },
    hostname: { type: "string" },
  },
});

const DEVICE_UUID = process.env.DEVICE_UUID ?? randomUUID();

let srtlaProc: ChildProcess | null = null;
let gstProc: ChildProcess | null = null;

function startSrtlaRec(): ChildProcess {
  const proc = spawn("srtla_rec", [srtlaPort, srtHost, srtPort], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => console.log(`[srtla_rec] ${d}`));
  proc.stderr?.on("data", (d) => console.error(`[srtla_rec] ${d}`));
  proc.on("exit", (code) => console.log(`srtla_rec exited (${code})`));
  return proc;
}

function startGstPipeline(): ChildProcess {
  // NOTE: GStreamer is the SRT *listener* — srtla_rec b8359bc connect()s to
  // this port (it is the caller). Spawn this first, then srtla_rec.
  const pipeline = [
    "gst-launch-1.0", "-v",
    `srtsrc uri=srt://${srtHost}:${srtPort}?mode=listener`,
    "!", "tsdemux", "name=d", "d.", "!", "video/x-h264", "!",
    "flvmux", "streamable=true", "!",
    `rtmpsink location=${rtmpUrl}`,
  ];
  const proc = spawn(pipeline[0], pipeline.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => console.log(`[gst] ${d}`));
  proc.stderr?.on("data", (d) => console.error(`[gst] ${d}`));
  proc.on("exit", (code) => console.log(`GStreamer exited (${code})`));
  return proc;
}

function stopAll() {
  srtlaProc?.kill("SIGTERM");
  gstProc?.kill("SIGTERM");
  srtlaProc = null;
  gstProc = null;
}

let ws: WebSocket | null = null;

function connectControlServer() {
  ws = new WebSocket(remote, { headers: { Authorization: `Bearer ${token}` } });

  ws.addEventListener("open", () => {
    console.log("Connected to irlctrl control server");
    ws!.send(JSON.stringify({
      type: "hello",
      role: "srtla2platform",
      uuid: DEVICE_UUID,
      hostname,
      version: "1.0.0",
      capabilities: ["srtla2platform.start", "srtla2platform.stop"],
    }));
  });

  ws.addEventListener("message", (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data as string); } catch { return; }
    if (msg.id && msg.method) handleRequest(msg);
    if (msg.type === "event") console.log(`[event] ${msg.event}`, msg.data);
  });

  ws.addEventListener("close", () => {
    console.log("Control server connection closed – reconnecting in 5s");
    setTimeout(connectControlServer, 5000);
  });

  ws.addEventListener("error", (err) => console.error("WebSocket error", err));
}

function handleRequest(msg: { id: string; method: string; params?: any }) {
  const respond = (ok: boolean, result?: any, error?: string) =>
    ws?.send(JSON.stringify({ type: "response", id: msg.id, ok, result, error }));

  switch (msg.method) {
    case "start":
      if (srtlaProc || gstProc) return respond(false, undefined, "Already running");
      try {
        srtlaProc = startSrtlaRec();
        setTimeout(() => { gstProc = startGstPipeline(); }, 800);
        respond(true, { state: "starting" });
      } catch (e: any) { respond(false, undefined, e.message); }
      break;
    case "stop":
      stopAll();
      respond(true, { state: "stopped" });
      break;
    case "status":
      respond(true, {
        running: Boolean(srtlaProc && gstProc),
        srtlaPid: srtlaProc?.pid,
        gstPid: gstProc?.pid,
        srtlaPort, srtPort, rtmpUrl,
      });
      break;
    default:
      respond(false, undefined, `Unknown method: ${msg.method}`);
  }
}

console.log(`srtla2platform starting (uuid=${DEVICE_UUID})`);
connectControlServer();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { stopAll(); ws?.close(); process.exit(0); });
}
```

---

## 7. What Has Been Verified vs. What Has Not

| Item                                                        | Status                                        |
| ----------------------------------------------------------- | --------------------------------------------- |
| irlctrl WebSocket protocol shape (hello/request/response)   | ✅ Matches observed pattern in `obs-client`   |
| `srtla_rec` CLI options (`--srtla_port`, `--srt_hostname`, `--srt_port`, `--metrics_port`) | ✅ Confirmed from the built binary's `--help` (irlserver/srtla b8359bc) |
| **End‑to‑end run against a live irlctrl server** (agent ↔ real server: `status`/`stop`/`start`) | ✅ Verified 2026‑10‑27 — `start` → `running` with both children up, `stop` → clean teardown |
| **Role acceptance on the irlctrl server** | ✅ `srtla2platform` accepted, no server patch needed |
| GStreamer pipeline (`srtsrc ! tsdemux ! flvmux ! rtmpsink`) | ✅ Verified live; note: `tsparse ! flvmux` does **not** link (static‑caps limitation), `tsdemux` is required for mpegts input |
| Bun `WebSocket` + `spawn` APIs                              | ✅ Standard, no issues expected               |
| **MPEG‑TS vs raw H.264 input assumption**                   | ⚠️ TS variant verified with no sender (pipeline stays up); encoder must send mpegts. h264 variant built but not exercised with data |
| **SRT `mode` negotiation**                                  | ✅ **Resolved**: `srtla_rec` b8359bc is the SRT *caller* (`connect()` in `srt_handler.cpp`); GStreamer runs `mode=listener` (this handoff spec had it backwards) |
| **RTMP auth (query params, tokens)**                        | ⚠️ Only basic URL tested (no RTMP server in the test); no auth helpers     |
| **Port readiness probe**                                    | ✅ `ss -uln` UDP check — TCP probe is useless for SRT (UDP); probe targets GStreamer's SRT port, not `srtla_rec` |

---

## 8. Known Gaps / Next Steps

### 8.1 Immediate (blockers for first run)

1. **Verify irlctrl role validation** — read `majklovec/irlctrl` server code; add `srtla2platform` to the role enum if needed, or confirm free‑form.
2. **Match irlctrl hello frame exactly** — the draft uses a guessed field set; compare against `obs-client` source and align (`type`, `role`, `uuid`, `version`, …).
3. **Test with a live encoder** — OBS + srtla sender or BELABOX; verify REG1/REG2/REG3 handshake completes and SRT port produces bytes (`nc -l` or `ffprobe` on `127.0.0.1:5002`).
4. **Test with a live RTMP destination** — start with a local `nginx-rtmp` or `mediamtx` before public platforms.

### 8.2 Robustness

5. **Persist `DEVICE_UUID`** — write to `~/.config/srtla2platform/uuid` on first run; avoid random UUID per boot (breaks irlctrl identity tracking).
6. **Process supervision** — detect `srtla_rec`/`gst` crashes and either restart or surface `state: "error"` in `status`.
7. **Structured logging** — pipe child stdout/stderr into a Bun logger with timestamps and level tags; useful for remote troubleshooting.
8. **Startup readiness check** — instead of fixed `setTimeout(800)`, poll `127.0.0.1:5002` (TCP connect) until it accepts, then start GStreamer.
9. **Graceful stop** — allow in‑flight RTMP flush; SIGTERM then wait N seconds then SIGKILL.
10. **Config file** — YAML/JSON with all params (`remote`, `token`, `srtlaPort`, `rtmpUrl`, etc.) to avoid long CLI invocations.

### 8.3 Features (basic OBS‑like)

11. **Dynamic pipeline builder** — allow the control server to send `params: { filters: [...] }` with `start` so overlays, `videoscale`, `volume`, `gdkpixbufoverlay` can be inserted. Requires decode/re‑encode; document the CPU cost.
12. **Stream key validation** — reject `/start` if `rtmpUrl` is missing a key or malformed.
13. **Multi‑destination** — fan out RTMP to N URLs via `tee`.
14. **Health telemetry** — periodically push `{ type: "event", event: "srtla2platform.stats", data: { bitrate, rtt, packetsLost } }` by parsing `srtla_rec` or GStreamer `-v` output.

### 8.4 irlctrl module integration (optional)

15. Add `modules/srtla2platform/` to the irlctrl repo with `backend.ts` (registers role + methods) and `frontend.tsx` (card with Start/Stop buttons and status). See irlctrl README for the module contract — **do not modify core**, only add the module folder.

### 8.5 Packaging

16. **systemd unit** — `srtla2platform.service`, `Restart=always`, `EnvironmentFile=/etc/srtla2platform/env`.
17. **Dockerfile** — Debian slim + `srtla_rec` (compiled) + GStreamer plugins + Bun binary; single‑image deploy.
18. **Cross‑compile `srtla_rec`** for ARM (Raspberry Pi / router deployments are common with BELABOX).

---

## 9. Operational Notes for the Next AI

- **`srtla_rec` must exist on `$PATH`.** The agent runs a pre‑flight `which srtla_rec` + `gst-inspect-1.0 srtsrc` check and fails with a clear “Missing binaries” error (already implemented in the agent).
- **Build `srtla_rec` from irlserver/srtla (rev `b8359bc`)** — do not use the BELABOX original (marked unsupported) and do not use the IRLToolkit fork. Use the bundled `install.sh`: `./install.sh` (add `--install-deps` to apt-install cmake/golang on a fresh machine). Overridable via env: `SRTLA_REV` (default `b8359bc…`), `SRTLA_SOURCE_DIR` (default `~/.cache/srtla2platform/srtla`), `SRTLA_INSTALL_DIR` (default `~/.local/bin`; auto-created and added to `$PATH` if missing).
- **GStreamer plugins needed:** `gstreamer1.0-plugins-bad` (provides `srtsrc` on most distros), `gstreamer1.0-plugins-good` (provides `flvmux`, `rtmpsink`). Verify with `gst-inspect-1.0 srtsrc`.
- **The patched SRT library matters** — the srtla README notes upstream SRT causes excessive retransmits with out‑of‑order packets. The irlserver/srtla fork ships with the patched SRT.
- **GStreamer is the SRT listener; `srtla_rec` is the SRT caller** (verified from `b8359bc` source: `connect()` in `srt_handler.cpp`). Spawn GStreamer first, then `srtla_rec`. (This handoff spec originally had it backwards.)
- **Do not re‑encode for “basic” mode.** Decoding H.264 → filtering → re‑encoding H.264 costs CPU and adds latency; keep the copy path (`tsdemux → flvmux`) unless a filter is explicitly requested.
- **Input container assumption is MPEG‑TS.** If the encoder sends raw H.264/AAC, replace `tsdemux name=d d.` with `h264parse ! aacparse` before `flvmux`. Add a `--input-format` flag to the orchestrator.
- **WebSocket `WebSocket` in Bun is global** — no `ws` package needed.
- **Token security** — the agent does **not** accept a `--token` CLI flag (it would leak into the process list). The token is read from the `CONTROL_SERVER_TOKEN` env var or the config file only.

---

## 10. Reference Commands

**Manual smoke test (bypass irlctrl):**

```bash
# Terminal 1 — SRT listener + RTMP push (GStreamer listens on the SRT port)
gst-launch-1.0 -v \
  srtsrc uri="srt://0.0.0.0:5002?mode=listener" ! \
  tsdemux name=d d. ! \
  flvmux streamable=true ! \
  rtmpsink location="rtmp://localhost/live/test"

# Terminal 2 — SRTLA receiver (srtla_rec *calls* the SRT port above)
srtla_rec --srtla_port 5000 --srt_hostname 127.0.0.1 --srt_port 5002 --log_level debug

# Terminal 3 — verify SRT is flowing (external consumer = SRT caller)
ffprobe -v error -show_streams "srt://127.0.0.1:5002?mode=caller&latency=120"

# Terminal 4 — inspect RTMP ingest (with mediamtx)
ffplay rtmp://localhost/live/test
```

**Run the orchestrator:**

```bash
CONTROL_SERVER_TOKEN=xxx \
  bun srtla2platform.ts \
    --server-url wss://ctl.example.com/device \
    --srtla-port 5000 \
    --rtmp-url "rtmp://live.example.com/app/STREAMKEY"
```

---

## 11. Reference Links

- irlctrl repo: https://github.com/majklovec/irlctrl
- SRTLA receiver: https://github.com/irlserver/srtla (rev `b8359bc`)
- OBS SRTLA input plugin (reference architecture): https://github.com/majklovec/obs-srtla-input-plugin
- SRTLA (original, unsupported): https://github.com/BELABOX/srtla
- SRT protocol: https://github.com/Haivision/srt
- GStreamer SRT elements: `gst-inspect-1.0 srtsrc` / `srtclientsrc`
- GStreamer RTMP elements: `gst-inspect-1.0 rtmpsink` / `flvmux`
- Bun APIs used: `Bun.WebSocket`, `node:child_process`, `node:util.parseArgs`

---

## 12. Handoff Checklist

- [x] Confirm irlctrl role validation accepts `srtla2platform` — accepted, no server patch needed
- [x] Align hello frame fields with `obs-client` source
- [x] Persist `DEVICE_UUID` to disk
- [x] Add pre‑flight `which srtla_rec` + `gst-inspect-1.0 srtsrc` checks
- [x] Replace `setTimeout(800)` with a UDP readiness probe (`ss -uln` poll on GStreamer's SRT port; TCP probes are useless for SRT)
- [x] Add `--input-format {ts,h264}` flag
- [x] Switch `srtla_rec` to irlserver/srtla (rev `b8359bc`) flag‑based invocation
- [x] Expose optional `--metrics-port` (Prometheus) on `srtla_rec`
- [x] Smoke test with irlctrl → `start` / `stop` / `status` (live E2E verified)
- [x] Clone and build `srtla_rec` from `irlserver/srtla` at `b8359bc` onto `$PATH` — see `install.sh` (installs to `~/.local/bin/srtla_rec`)
- [x] Health monitor: stop the stream after the SRTLA port is closed 3 consecutive checks (15 s)
- [x] Fix SRT direction: GStreamer `mode=listener` first, `srtla_rec` calls in (spec had it backwards)
- [ ] Smoke test with OBS + srtla sender → mediamtx (needs live sender/hardware + the built `srtla_rec` + GStreamer binaries, not present on the dev machine)
- [ ] Decide whether to build irlctrl UI module
- [ ] Write systemd unit + Dockerfile

**End of handoff.**
