# Modules

The module system in one paragraph: every capability is a self-contained
`modules/<id>/` directory, and the core (`src/` + `public/`) never imports a
module by id — it discovers, routes, and renders through the registries and
the capability bus. A high-level tour (per-module descriptions, how discovery,
routing, and ordering work, and how to add a module) lives in the
[main README](../README.md#modules). This file is the detailed reference: the
layout, the registration contract, discovery mechanics, and the edge cases.

## Layout

```
modules/
  .generated.frontend.ts     # gitignored — produced by scripts/gen-modules.ts
  .generated.backend.ts      # gitignored — produced by scripts/gen-modules.ts
  README.md
  encoder/                   # device modules
  srtla/
  modems/
  obs-controller/
  stats/     chat/                                                  # channel widget modules
```

Each module ships exactly:

-   `backend.ts` — default-exports a backend registration. Runs in Bun on the
    host: **no** mithril/DOM, no browser globals.
-   `frontend.tsx` — default-exports a frontend registration. Runs in the browser
    (mithril components), **no** `../../src` imports.
-   `types.ts` — **this module's** local types: its own config keys, status
    fragment, capability types, hub/widget types. Core-free.
-   `styles.css` — scoped under `.mod-<id>` (device card) or `.dash-card`
    (dashboard widget).
-   any number of plain helpers for its own use (e.g. obs-controller's
    `switcher-engine.ts`, stats' `graph-linechart.tsx`)

There is no shared `modules/types.ts`, no `modules/widgets.ts`, no
`modules/registry.*.ts` — the old aggregate layer is gone. The only thing in
`modules/` that spans modules is the **generated** manifest. A module's
`types.ts` may import core-owned types (`Status` from `public/types`,
`Method` from `src/methods`); it must not import another module.

Frontend views are written in TSX and transformed by Bun using the Mithril
pragma configured in `bunfig.toml`. Use Mithril attributes such as `class` and
lowercase lifecycle/event names (`oncreate`, `onclick`, `oninput`).

## The registration contract

### Backend (`modules/<id>/backend.ts`)

Default-exports an object the registry validates structurally:

| field                              | required | purpose                                                                                                                                               |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`, `id`, `title`              | yes      | identity (`id` = directory name)                                                                                                                      |
| `configSchema`                     | yes      | `Record<field, {label, type, default, options?, min?, max?, step?}>` — the UI renders the config form from this                                       |
| `secretFields`                     | yes      | config field names that are masked                                                                                                                    |
| `methods`                          | yes      | ordered list of RPC methods this module answers                                                                                                       |
| `events`                           | yes      | ordered list of events it emits                                                                                                                       |
| `start({config, emit, log, core})` | yes      | bring it up; `core` is the per-role services object (subprocess, srtla, …)                                                                            |
| `stop()`                           | yes      | tear down                                                                                                                                             |
| `dispatch(method, params)`         | yes      | handle an RPC call routed to this module                                                                                                              |
| `status?()`                        | no       | status fragment merged into `sys.status` (`buildStatus` asks it; the core never imports the module for this)                                          |
| `services?`                        | no       | `{ capabilities?: Record<string, Capability> }` — see the capability bus                                                                              |
| `hub?`                             | no       | channel-widget hub (`widgetType`, `snapshotKey`, `configFields`, `channelSpec` (one spec per channel, `null` for unconfigured), `create`, `enabled?`) |
| `dependencies?`                    | no       | ids of modules that must have `start()`ed first (see ordering)                                                                                        |

### Frontend (`modules/<id>/frontend.tsx`)

Default-exports an object the generated manifest re-exports and the frontend
registry bridges:

| field                   | purpose                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `kind`, `id`, `title`   | identify the device-card or independent-widget registration                                   |
| `available?(status)`    | decide whether a device card is applicable to the current status                              |
| `component`            | render a device card                                                                       |
| `dashboardWidgets?`     | declare opaque device-widget types, eligibility, sizing, rendering, badges, and cleanup       |
| `setupSteps?`           | declare setup ordering, eligible roles, validation, rendering, and payload contribution       |
| `deviceSummaryColumns?` | declare device-list columns, ordering, eligibility, and cell rendering                        |
| `configFields?`         | declare independent-widget editor fields                                                      |
| `onFrame?`, `handleEvent?` | receive generic server or device events and update module-owned state                       |

## Discovery (the core names no module)

-   **Backend** — `src/registry.ts` `readdirSync`s `modules/*/` and imports each
    `backend.ts`'s default export. Add a directory, it appears. (In a compiled
    binary the runtime scan can't reach disk, so it falls back to the generated
    `modules/.generated.backend.ts` manifest — same scan, same shape.)
-   **Frontend** — the browser bundle cannot glob at runtime, so
    `scripts/gen-modules.ts` writes `modules/.generated.frontend.ts` (a fixed
    `export const FRONTEND_MANIFEST = [...]` of `{ id, path }` entries) from the
    same `readdirSync` scan. `src/registry.frontend.ts` does a plain `import` of
    that manifest — **no Glob, no module ids in core source**. The manifest is
    gitignored and regenerated by `predev` (and `gen:modules`).

Tests pin both directions: the frontend registry must import the manifest (and
contain no `Glob`/`modules/*` import patterns), and the manifest must exist and
be marked auto-generated.

## Core ↔ module: registries and the capability bus only

-   `src/methods.ts` routes RPC methods via the registry's method-owner map
    (built from each module's `methods` array) — it does not import any module.
-   `src/registry.frontend.ts` exposes accessors the UI calls: `moduleCards(status)`,
    dashboard/setup/summary contribution accessors,
    `getFrontendModule(id)`, and `WIDGET_MODULES`.
-   **Capability bus** — a module that exposes a service registers it under a
    dotted name (`stream.encoder`, `stream.srtla`) in `services.capabilities`;
    consumers look it up by name through `src/capabilities.ts` rather than
    importing the providing module. Frontend modules use the per-connection
    `DeviceCard` capability API for the same purpose; the core stores and
    forwards capabilities without knowing their names or signatures.
-   The browser core has no direct imports from `modules/<id>/`. The generic,
    type-only contribution interfaces live in `public/ts/module-contracts.ts`;
    module implementations and event types remain module-owned.

Each module's `frontend.tsx` side-effect-imports its own `styles.css`
(`import "./styles.css"`); Bun's bundler emits it into the page (see
`css.d.ts`), so the core never pulls module CSS by id. Components use mithril +
CSS classes.

## Self-contained frontend contract

Device modules describe their UI through generic contributions, keeping
module-owned behavior inside `modules/<id>/`:

- **Device cards** declare their eligibility from the shared status and own
  their component and dashboard-card rendering.
- **Dashboard widgets** declare opaque widget types, eligibility, configuration
  fields, rendering, badges, and any module-owned live state. Core supplies
  generic device connection and layout context; it does not interpret a
  widget type or import a module component.
- **Setup steps** declare their order, visibility, validation, rendering, and
  the configuration values they contribute. The shared wizard retains generic
  language, identity, and control-server steps and combines module values for
  `setup.complete`.
- **Device summaries** contribute their own columns and cell renderers. The
  shared device list retains generic identity, connection, and layout behavior.

The shared `Role` vocabulary remains an application configuration/wire
contract. UI eligibility and behavior for a role belong in module
contributions, not role-specific branches in core pages. Widget type strings
are opaque registry keys. Stateful panels (including OBS controls) are created,
updated, and destroyed by their owning module; the core passes a generic device
context and RPC capability.

Core pages compose and invoke contributions, but do not contain module-owned
status-field logic, widget-type switches, or direct imports from `modules/*`.
Module-specific pages, such as the encoder pipeline editor, live inside their
owning module. Frontend modules communicate through generic per-connection
capabilities, not direct imports from one another. The structural contribution
contract is defined in `public/ts/module-contracts.ts`; modules may import it
by type only, but do not import the core registry.

## Elysia server target

Both server entry points use Elysia app factories. The centralized control
server composes plugins by route domain: public pages/assets, authentication
and profile, device connections/viewers, and dashboards/widgets. The
device-local API composes page/assets and WebSocket RPC plugins. Each plugin
owns its routes and socket lifecycle and receives domain services through its
factory options.

The RPC method handlers remain transport-agnostic and shared by the local
device socket and outbound remote connection. Elysia changes server
composition, not the HTTP response contracts, authorization rules, WebSocket
frame shapes, dashboard persistence, or compiled-server asset behavior.

## Ordering

`resolveOrder(discovered)` (in `src/registry.ts`) topologically sorts modules
by their `dependencies` (cycle-safe, deterministic: id-sorted when no edges).
No module currently declares `dependencies`, so the order is the id sort.
`startModules` / `stopModules` / `buildStatus` / `modulesView` all iterate
`ALL_MODULES = resolveOrder(...)` — never a hand-maintained list.

## Adding a module

1. `mkdir modules/<id>`; write `backend.ts` (default-export registration
   above), `frontend.tsx` (default-export registration), `types.ts`,
   `styles.css`.
2. Device module: register its dashboard, setup, and summary contributions as
   needed. Channel widget: register `body`/`badge` and config fields so it
   appears in `WIDGET_MODULES`.
3. If it must start after another module, add `dependencies: ["<id>", ...]`.
4. **No core edits needed** for discovery — the backend scan picks it up and
   `predev` regenerates the frontend manifest. The only core touch is `src/`
   wiring for a brand-new core service the module needs.

Module method and event names are frozen: renaming one is a breaking API
change.
