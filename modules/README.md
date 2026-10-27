# Modules

Every capability is a self-contained `modules/<id>/` directory, and the core
(`backend/` + `frontend/` + `shared/`) contains no module-specific code: it
discovers, routes and renders through the registration contracts, the
registries and the capability bus. A high-level tour lives in the
[main README](../README.md#modules); this file is the reference: layout, the
two contracts, discovery, persistence and the edge cases.

## Layout

```
.
├── generated/                # gitignored generated manifests / embedded assets
│   ├── frontend-assets.ts
│   ├── modules.backend.ts
│   ├── modules.frontend.ts
│   └── modules.settings.ts
└── modules/
    ├── README.md
    ├── encoder/              # device modules
    ├── srtla/
    ├── modems/
    ├── obs-controller/
    ├── ssh/
    ├── stats/                # channel widget modules
    └── chat/
```

A module ships:

-   `backend.ts` — default-exports a `BackendModule` (see
    [`shared/module-contract.ts`](../shared/module-contract.ts)). Runs in Bun on
    the host: **no** mithril/DOM. It parses its own CLI arguments
    (`shared/args`), owns its persisted sections, validates its own RPC
    parameters (`shared/params`) and reaches the process only through the
    `core` bag it is handed.
-   `frontend.tsx` — default-exports a `FrontendModule` / `ChannelWidgetModule`
    (see [`frontend/ts/module-contracts.ts`](../frontend/ts/module-contracts.ts)),
    or an array of them. Runs in the browser; **no** backend imports.
-   `types.ts` — the module's own types, including its wire shapes (status
    fragment, method results, events). It may import core-owned *types*
    (`ModuleCore` from `backend/client/module-core`, the contracts, the core
    wire vocabulary in `shared/types`: `Status`, `DeviceSummary`, `SetupInfo`,
    `Settings`); it must not import another module. A module that renders
    another module's data (the srtla card shows the modems' interfaces)
    declares the shapes it reads locally — structural duplicates, never imports.
-   `styles.css` — scoped under `.mod-<id>` (device card) or `.dash-card`
    (dashboard widget); side-effect-imported by `frontend.tsx`.
-   optional `settings.tsx` — a settings-page card (`ModuleDef`, see
    `frontend/ts/modules.tsx`).
-   optional `log.ts` — the module's log wording, imported by both sides.
-   optional `i18n/<lang>.json` — the module's translations (one file per
    supported language, same keys in each). They are merged over the core
    catalog (`i18n/<lang>.json`) at runtime and served to the browser as one
    `/i18n/<lang>.json`; keys must be unique across the core and the modules
    (`test/i18n.test.ts` pins both).
-   optional `pages/*.html` — module-owned page entry points, bundled with the
    shared frontend assets and served at the paths the backend declares in
    `pages`.
-   any number of private helpers (`switcher-engine.ts`, `routing.ts`, …).

Modules may import the dependency-free helpers in `shared/` (`args`, `params`,
`i18n`, `util`, `validate`, `logMessages`, `types`, `obs/client`). They must not
import `backend/client/*` (except the `ModuleCore` type) nor `frontend/ts/*`
beyond the contracts, components, store, i18n and util helpers a card needs.

## The backend contract (`BackendModule`)

| field                               | purpose                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`, `id`, `title`               | identity (`id` = directory name; `kind` is `device` or `widget`)                                                                                                                                                                                        |
| `roles?`                            | roles the module serves: its methods are rejected (409) on other roles, its status/settings/setup hooks only run on them, and its slice starts `enabled` on them. Omit for "every role".                                                                |
| `methodRoles?`                      | per-method role override (`{ "stream.start": ["combined"] }`)                                                                                                                                                                                           |
| `enabledByDefault?`                 | `false` keeps the slice disabled on a fresh device even on its roles (opt-in modules)                                                                                                                                                                   |
| `requireEnabled?`                   | reject the methods (409) while the slice is disabled                                                                                                                                                                                                    |
| `configKey?`                        | key of the slice under `settings.modules` (default `id`; `srtla` keeps its historical `relay` key)                                                                                                                                                      |
| `configDefaults?`                   | defaults of the slice, deep-merged under the stored values at every load (new fields backfill, stored values win)                                                                                                                                       |
| `secretFields?`                     | slice fields the status masks as `{ configured }`                                                                                                                                                                                                       |
| `methods`, `events`                 | the RPC methods it answers and the events it emits (frozen API names)                                                                                                                                                                                   |
| `dispatch(method, params)`          | handle one call: validate `params` (throw `ApiError` from `shared/params`), act, return the result                                                                                                                                                      |
| `log?`                              | log wording (`methods`, `reads`, `sections`, `labels`) merged into `shared/logMessages`; a method listed in `methods` is recorded in the event log and its response carries `logged: true`                                                               |
| `dependencies?`                     | ids that must `start()` first; also orders status, resume and stop (reverse)                                                                                                                                                                            |
| `bind?(core)`                       | receive the process bag at discovery, before start (a disabled module is still bound, so lazy objects can report "stopped")                                                                                                                             |
| `start({config, emit, log, core})`  | bring the module up; `config` is its slice                                                                                                                                                                                                              |
| `stop()`                            | tear down (a no-op for a module that never started)                                                                                                                                                                                                     |
| `resume?()`                         | autostart: resume the last saved run; `true` when something is running                                                                                                                                                                                  |
| `status?()`                         | fragment deep-merged into the `status` payload; persisted bits go under `state`, device-list fields under `summary`                                                                                                                                     |
| `settings?()`, `setupInfo?()`       | fields merged into `settings.get` / `setup.get`                                                                                                                                                                                                         |
| `setup?(params, role)`              | first-run wizard: validate the module's answers and return the apply step; nothing is applied until every module validated                                                                                                                               |
| `configure?(config, slice)`         | apply a `modules.configure` payload to the slice (default: only `enabled`); the module is restarted afterwards                                                                                                                                           |
| `pages?`                            | `{ match: RegExp, page }[]` — the device-relative paths that serve `pages/<page>.html` (the control server mirrors them under `/d/<id>/`)                                                                                                                 |
| `dashboardWidgets?`                 | device-bound dashboard widget types with their default grid size (the server validates dashboards against them)                                                                                                                                         |
| `services?.capabilities`            | `{ "<name>": impl }` offered to other modules over the bus                                                                                                                                                                                              |
| `hub?`                              | channel-widget hub (`widgetType`, `snapshotKey`, `defaultSize`, `configFields`, `channelSpec`, `create`)                                                                                                                                                 |

### The process bag (`ModuleCore`)

`core.config` (`argv`, `CONFIG_FILE`, `DRY_RUN`, `LOG_FILE`, `ROLE`),
`core.role()` (effective role), `core.state` (`settings`, `autostart`, `data`),
`saveState`, `notifyStateChange` (status broadcast without a save),
`onStateChange`, `moduleEnabled(id)`, `cancelAutostart()`, `logEvent`, `run`,
`writeFileAtomic`, `Supervisor`, `requireCapability` / `hasCapability`,
`listDevices` / `requestDevice` (control-server mediated).

### Persistence

`config.json` = the core keys (`uuid`, `hostname`, `role`, `remoteUrl`,
`remoteToken`, `color`, `language`, `autostart`, `modules`) plus every other
top-level key verbatim as a module section in `core.state.data`. A module reads
and mutates its own sections (`data.srtla`, `data.encoder`, `data.modems`, …)
and calls `core.saveState()`; runtime state (pids, counters) stays in module
variables. The per-module settings slices (`settings.modules[<configKey>]`)
are seeded from `roles` + `configDefaults` when setup completes and backfilled
at every load.

### Pushes

`ctx.emit(event, data, opts?)` sends `{ type: "event", event, data, module }` to
every connected client. `opts.throttle` rate-limits the event per sink (the
control-server link uses `--remote-stats-interval`), `opts.retain` keeps the
last frame for replay to new connections (`retain: false` drops it), and
`opts.summary` carries device-list fields the control server merges into the
device entry (per module; send `{}` to clear them).

## The frontend contract

`FrontendModule` (device card): `kind: "device-card"`, `id`, `title`, `order`,
`available(status)`, `component(status)`, `defaultSize` / `minSize`, plus the
contributions the core pages compose — `dashboardWidgets`, `setupSteps`,
`deviceSummaryColumns`, `handleEvent(event, data, host)` and `log`.
`ChannelWidgetModule` (dashboard widget): `kind: "widget"`, `widgetTypes`,
`defaultSize`, `configFields`, `body` / `badge`, `onFrame`.

Core pages compose contributions; they contain no widget-type switches, no
module status fields and no imports from `modules/*`. Frontend modules talk to
each other through the per-connection `DeviceCard` capability API
(`host.provideCapability` / `host.getCapability`), never by import.

## Discovery (the core names no module)

-   **Backend** — `shared/registry.ts` `readdirSync`s `modules/*/`, imports each
    `backend.ts` default export and validates it structurally (a malformed
    registration fails the boot with the module id). Compiled binaries use the
    generated `generated/modules.backend.ts` manifest instead.
-   **Frontend** — `scripts/gen-modules.ts` writes `generated/modules.frontend.ts`
    and `generated/modules.settings.ts` (one static import per
    `modules/<id>/frontend.tsx` / `settings.tsx`); `frontend/ts/module-registry.ts`
    and `frontend/ts/modules.tsx` import those manifests — no Glob, no module
    ids in core source. Regenerated by `predev` / `gen:modules`.

`test/registries.test.ts` pins the boundary: the core must not import from
`modules/<id>/`, the registries must discover through the manifests, and the
frontend pages must stay free of module feature branches.

## Capabilities

| name           | provider | consumers | shape                                                                                               |
| -------------- | -------- | --------- | --------------------------------------------------------------------------------------------------- |
| `net.uplinks`  | modems   | srtla     | `{ file, reconfigure() }` — the uplinks file `srtla_send` reads and the routing re-sync              |
| `stream.srtla` | srtla    | encoder, modems | `{ srtlaStatus(), startSrtla(), stopSrtla(), reloadSrtla(), target() }` — combined streaming, uplink reloads |

A consumer declares the shape it expects locally (in its `types.ts`) and looks
it up by name; removing a provider breaks only the capabilities that depended
on it.

## Ordering

`resolveOrder` (in `shared/registry.ts`) topologically sorts modules by their
`dependencies` (cycle-safe; ids visited alphabetically). Today: `modems` →
`srtla` → `encoder` → `obs-controller` → `ssh`. `startModules` / `stopModules`
(reverse) / `moduleStatuses` / autostart all iterate that order.

## Adding a module

1. `mkdir modules/<id>`; write `backend.ts` (default-export a `BackendModule`),
   `frontend.tsx` (default-export a `FrontendModule` or `ChannelWidgetModule`),
   `types.ts`, `styles.css`.
2. Declare `roles`, `methods`, `events`, the hooks you need, `log` wording,
   `pages` / `dashboardWidgets`, and `dependencies` if it must start after
   another module.
3. Put the module's translations in `modules/<id>/i18n/<lang>.json` (all
   languages in `shared/languages.ts`) and its wire types in `types.ts`.
4. **No core edits** — the backend scan picks it up and `predev` regenerates
   the frontend, settings and i18n manifests.

Module method and event names are frozen: renaming one is a breaking API
change.
