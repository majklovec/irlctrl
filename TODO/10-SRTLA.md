# Handoff Document: `irlctrl` — SRTLA-Everywhere Migration

**Repo:** `https://github.com/majklovec/irlctrl`
**Scope:** Rewire encoder→relay transport from SRT to SRTLA, make relay a full SRTLA→SRTLA bridge, delete the `combined` role.
**Status of spec:** All open questions resolved. This is the implementation spec.

> **Before writing any code:** Clone the repo, inventory the actual roles, Dockerfiles, compose files, CI workflows, and tests. The maintainer (me) could not fetch the repo while writing this doc; the paths and file names below are best-guess based on the maintainer's description plus standard BELABOX tooling (`srtla_send` / `srtla_rec`). **Verify every path against the real repo and update this document as you go.** Do not assume a file exists just because it's listed here.

---

## 0. Resolved decisions

| #   | Question                                          | Decision                                                          |
| --- | ------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Relay topology                                    | **Full bridge:** `srtla_rec → local SRT → srtla_send`             |
| 2   | Backward compatibility (plain SRT input on relay) | **None.** Hard cutover — relay no longer accepts plain SRT input. |
| 3   | `combined` role                                   | **Hard delete.** No alias, no deprecation shim, no stub.          |
| 4   | Encoder→relay SRTLA port                          | **UDP 6000** (default, configurable)                              |
| 5   | Other roles ("and others")                        | **Untouched.** Only `encoder`, `relay`, and removing `combined`.  |

---

## 1. Objective

Change the encoder→relay hop from **SRT** to **SRTLA**, make the relay a **full SRTLA→SRTLA bridge**, and **delete the `combined` role** because its behavior becomes exactly what the new encoder does.

### Current architecture

```
encoder:  encode ──SRT───────────►  relay: recv SRT ──SRTLA──►  destination (srtla_rec)
combined: encode ──SRT──► (built-in relay) ──SRTLA──►           destination
```

### Target architecture

```
encoder:  encode ──SRTLA (UDP 6000)──►  relay
relay:    srtla_rec(6000) ──SRT loopback:5000──► srtla_send ──SRTLA──►  destination
combined: (removed — its outbound SRTLA path lives inside encoder)
```

Key rules:
- **Encoder outbound leg = old `combined` outbound leg.** Reuse the existing code verbatim. Do not reimplement SRTLA sending.
- **Relay inbound leg becomes `srtla_rec`.** Relay outbound `srtla_send` code path is unchanged.
- The `srtla_rec → srtla_send` internal SRT hop runs on **loopback only** and must never be exposed outside the container (default internal port 5000, configurable).

---

## 2. Required changes

### 2.1 Encoder role

1. **Port the SRTLA-send path from `combined`** into `encoder` — the helper function, the config parsing, the uplink/bond list handling, and the process spawning. Copy behavior exactly; do not rewrite.
2. **Destination config:** encoder's output must target either:
   - **the relay** (default: `<relay-host>:6000`), or
   - **the final destination** directly (preserves old `combined` direct-send mode).

   Preserve the same "direct vs relay" semantics `combined` had, if it had them. If it didn't, add a simple `ENCODER_DESTINATION=<host> <port>` config field.
3. **Image:** add `srtla_send` binary + runtime deps to the encoder Dockerfile (copy from `combined`'s Dockerfile). Verify the binary works in the encoder's base image.
4. **Config format:** `srtla_send` expects plain `ip port` lines, **not** an `srt://` URL. Reuse whatever format `combined` used for its uplink config. Do not pass `srt://…` into `srtla_send`.
5. **Remove** any encoder code path that still uses plain `srt://` for its output. This is a hard cutover.

### 2.2 Relay role

1. **Input side:** replace the existing SRT listener with **`srtla_rec`**:
   - Listen on UDP **6000** by default (`SRTLA_LISTEN_PORT`, default `6000`).
   - `srtla_rec` outputs a single SRT stream to `127.0.0.1:<SRT_INTERNAL_PORT>` (default **5000**, configurable via `SRT_INTERNAL_PORT`).
   - The internal SRT port binds to **loopback only** — do not expose it in Dockerfile `EXPOSE`, compose `ports:`, or any k8s/helm manifest.
2. **Bridge:** feed that internal SRT stream directly into the existing `srtla_send` outbound path. **Do not modify the outbound code.**
3. **Image:** add `srtla_rec` binary to the relay image. Verify multi-arch availability (see §3).
4. **Remove** the plain SRT listener. **No dual-listener, no fallback** (decision #2).
5. **Docker / compose / manifests:** expose UDP **6000**. Do **not** expose the internal SRT port.
6. **Healthcheck / wait-for-it / entrypoint gates:** change from "SRT port open" to "`srtla_rec` bound on UDP 6000." Update any readiness probe in compose or k8s.
7. **Config keys:** rename SRT-input keys to SRTLA ones. Suggested:
   - `SRT_LISTEN_PORT` → `SRTLA_LISTEN_PORT=6000`
   - New: `SRT_INTERNAL_PORT=5000`
   - Keep `srtla_send` destination keys unchanged.

### 2.3 Combined role — delete

- Delete the role directory / subcommand / CLI entry / Dockerfile / compose service / Makefile target / README section / CI matrix entry / tests.
- Grep the whole repo for `combined` (case-insensitive). Remove **every** reference.
- The **only** permitted remaining occurrence of "combined" in the repo is a new `CHANGELOG` entry documenting the removal and migration.
- Do not leave a "deprecated alias." Hard delete (decision #3).

### 2.4 Shared transport helper

- Extract the SRTLA-send helper currently living in `combined` into wherever this repo already places shared transport code (`internal/transport`, `pkg/srtla`, `lib/`, whatever the convention is).
- `encoder` and `relay` both consume that helper.
- If `relay` already had its own SRTLA-send helper, unify on the better one and delete `combined`'s copy.
- **Do not touch** shared code paths that belong to other roles.

### 2.5 Config, docs, ops

- **`README.md`** — update the architecture diagram, the role table, and remove the `combined` section. Add a "Migrating from `combined`" note pointing users to `encoder`.
- **`docker-compose.yml`** —
  - Delete the `combined` service.
  - Set encoder's default destination to `relay:6000`.
  - Expose UDP 6000 on relay: `ports: ["6000:6000/udp"]`.
  - Ensure the internal SRT port (5000) is **not** published.
  - Update `depends_on` if any service depended on `combined`.
- **`.env.example`** — replace SRT URL vars on encoder output / relay input with `srtla_send`'s `ip port` format. Document `SRTLA_LISTEN_PORT=6000` and `SRT_INTERNAL_PORT=5000`.
- **`Makefile`** — update or delete any `combined` targets. Add encoder and relay builds that now include the new binaries.
- **Helm / k8s / Terraform (if present)** — same treatment: remove `combined`, expose UDP 6000 on relay, do not expose internal SRT port.
- **`CHANGELOG.md`** — new entry:

  ```
  ### Removed
  - `combined` role. Its behavior is now the default for `encoder`.
    Migration: replace `combined` with `encoder` and point its destination
    at the relay (default: `<relay>:6000`) or directly at the final destination.
  ### Changed
  - Encoder → relay transport is now SRTLA (UDP 6000 default).
  - Relay input is now SRTLA; relay is a full SRTLA→SRTLA bridge.
  ```

### 2.6 Tests & CI

- **Encoder tests:** any test asserting SRT output must be rewritten to assert SRTLA output. Mock `srtla_rec` on UDP 6000 or capture packets.
- **Relay tests:** input side is now SRTLA. Spin up `srtla_send` in the test harness to feed the receiver, then verify frames bridge through `srtla_rec → SRT → srtla_send → destination`.
- **Combined tests:** delete entirely.
- **CI matrix:** remove `combined`. Ensure the `encoder` and `relay` jobs exercise the new paths.
- **New E2E smoke test:** `encoder(SRTLA) → relay(SRTLA) → destination`. Assert frames arrive at the destination.
- **Multi-arch builds:** if the repo supports arm64 and amd64 images, verify both build successfully with the new binaries (`srtla_send` in encoder, `srtla_rec` in relay).

---

## 3. Risks & gotchas

- **SRTLA config format.** `srtla_send` does **not** take an `srt://` URL. It takes plain `ip port` lines. Confirm the exact format `combined` used and copy it.
- **Two SRTLA pairs.** After this change there are two SRTLA pairs in the pipeline (encoder→relay and relay→destination). Keep their **ports distinct**. Relay listens on 6000; its outbound destination port is user-configured and must not be 6000.
- **Internal SRT port exposure.** It must be loopback-only. Check Dockerfile `EXPOSE`, compose `ports:`, and any k8s Service. A leaked internal SRT port is a security and correctness problem (clients could accidentally connect to the bridge mid-hop).
- **`srtla_rec` architecture.** Verify `srtla_rec` builds for the repo's target arch (arm64 is common for this project). If not, that's a blocker — raise it before proceeding.
- **MTU / packet size.** SRTLA pads packets. Verify no fragmentation on the encoder→relay hop, especially on cellular. Test with a realistic MTU (e.g. 1500, and 1400 for mobile).
- **Added latency on relay.** `srtla_rec → SRT → srtla_send` adds a re-send hop. Measure. Target: no worse than old `combined` latency. If it regresses materially, report before merging.
- **Existing deployments.** Users on `combined` will break. The `CHANGELOG` migration note is mandatory. The equivalent of `combined` is: run `encoder` and point it at the relay (default) or at the destination.
- **Healthchecks / `depends_on`.** Any compose/k8s logic that waits for relay's SRT port must be updated to wait for UDP 6000.

---

## 4. Definition of done

- [ ] Encoder sends SRTLA on UDP 6000 by default; output config surface matches old `combined` (relay-or-direct target).
- [ ] Relay: `srtla_rec` on UDP 6000 → SRT on loopback:5000 → `srtla_send` → destination.
- [ ] Relay internal SRT port not exposed in Dockerfile, compose, or k8s manifests.
- [ ] No plain-SRT listener remains on relay (no fallback).
- [ ] `combined` fully deleted — single permitted grep hit is the `CHANGELOG` migration note.
- [ ] No other role modified.
- [ ] README, `docker-compose.yml`, `.env.example`, `Makefile`, CI matrix updated.
- [ ] Encoder image includes `srtla_send`; relay image includes `srtla_rec`.
- [ ] E2E smoke test (`encoder → relay → destination`, both hops SRTLA) passes.
- [ ] Multi-arch builds pass (if the repo supports them).
- [ ] Manual real-network smoke test performed on at least one cellular uplink.

---

## 5. Suggested commit order

Do it in this order so **no commit loses the working `combined` reference** until the replacement is verified.
1. **Inventory.** Clone, list roles / Dockerfiles / compose services / CI workflows / tests. Post findings in the PR description and correct any guessed paths in this doc.
2. **Extract helper.** Move `combined`'s SRTLA-send code into the shared transport package. Behavior must be unchanged. Verify `combined` still works with this refactor.
3. **Rewire encoder.** Point encoder at the shared helper. Verify encoder→(mock relay or real relay)→destination works. Keep `combined` intact.
4. **Rewire relay.** Replace SRT listener with `srtla_rec`. Verify the full `srtla_rec → SRT → srtla_send` bridge locally (loopback only).
5. **Update compose / `.env.example` / README.** Default ports 6000 (relay listen) and 5000 (internal loopback). Encoder default destination is `relay:6000`.
6. **Delete `combined`.** Remove code, compose service, docs, CI, Makefile, tests.
7. **Update tests + add E2E smoke.**
8. **Run full CI + manual real-network E2E.**

---

## 6. Files likely to touch (verify against real repo)

- `roles/encoder/**` — pipeline, entrypoint, Dockerfile
- `roles/relay/**` — receiver, sender, entrypoint, Dockerfile
- `roles/combined/**` — **delete**
- `docker-compose.yml`
- `.env.example`
- `README.md`
- `CHANGELOG.md`
- `Makefile` (per-role targets)
- `tests/**`
- `.github/workflows/**` (CI matrix)
- Shared transport package (`internal/transport`, `pkg/srtla`, `lib/`, or whatever the repo uses)

---

## 7. Interfaces the implementing agent must produce

To avoid the next agent needing to re-derive config, the following must be **fixed and documented** in the README after this change:

**Encoder env vars**
| Var                        | Default                  | Meaning                                      |
| -------------------------- | ------------------------ | -------------------------------------------- |
| `ENCODER_DESTINATION_HOST` | `relay`                  | SRTLA destination host (relay or final dest) |
| `ENCODER_DESTINATION_PORT` | `6000`                   | SRTLA destination UDP port                   |
| `ENCODER_UPLINKS`          | (repo's existing format) | Bonded uplink list for `srtla_send`          |

**Relay env vars**
| Var                      | Default           | Meaning                                                                  |
| ------------------------ | ----------------- | ------------------------------------------------------------------------ |
| `SRTLA_LISTEN_PORT`      | `6000`            | UDP port `srtla_rec` binds to                                            |
| `SRT_INTERNAL_PORT`      | `5000`            | Loopback SRT port between `srtla_rec` and `srtla_send` — **not exposed** |
| `RELAY_DESTINATION_HOST` | (repo's existing) | Final SRTLA destination host                                             |
| `RELAY_DESTINATION_PORT` | (repo's existing) | Final SRTLA destination UDP port                                         |
| `RELAY_UPLINKS`          | (repo's existing) | Bonded uplink list for `srtla_send`                                      |

If the repo already uses different var names, keep the existing names and update this table — do not rename config keys just because this doc suggests names.

---

## 8. Escalation

Stop and ping the maintainer **before** merging if any of the following is true:
- `srtla_rec` cannot be built for the target arch.
- The relay bridge latency is measurably worse than old `combined` on a real uplink.
- `combined` turns out to share code with another role in a way that makes deletion non-trivial (i.e. deleting `combined` would break a role that is not supposed to change).
- Any role other than `encoder`, `relay`, or `combined` would need a modification to keep CI green.

Everything else is within the agent's discretion — prefer the simplest change that satisfies §4.
