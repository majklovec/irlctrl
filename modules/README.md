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
    ├── chat/
    └── buttons/              # fleet dashboard widget (virtual StreamDeck across devices)
```

A module ships:
-   `backend.ts` — default-exports a `BackendModule` (see
    [`shared/module-contract.ts`](../shared/module-contract.ts)). Runs in Bun on
    the host: **no** mithril/DOM. It parses its own CLI arguments
    (`shared/args`), owns its persisted sections, validates its own RPC
    parameters (`shared/params`) and reaches the process only through the
    `core` bag it is handed.
-   `frontend.tsx` — optional (only modules with a device-page card, a
    dashboard widget or a setup step need one; a settings-only module like
    `ssh` ships none). Default-exports a `FrontendModule` /
    `ChannelWidgetModule` (see
    [`frontend/ts/module-contracts.ts`](../frontend/ts/module-contracts.ts)),
    or an array of them. Runs in the browser; **no** backend imports.
-   `types.ts` — the module's own types, including its wire shapes (status
    fragment, method results, events). It may import core-owned _types_
    (`ModuleCore` from `backend/client/module-core`, the contracts, the core
    wire vocabulary in `shared/types`: `Status`, `DeviceSummary`, `SetupInfo`,
    `Settings`); it must not import another module. A module that renders
    another module's data (the srtla card shows the modems' interfaces)
    declares the shapes it reads locally — structural duplicates, never imports.
-   `styles.css` — scoped under `.mod-<id>` (device card) or `.dash-card`
    (dashboard widget); side-effect-imported by `frontend.tsx` /
    `settings.tsx`.
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

| field                              | purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`, `id`, `title`              | identity (`id` = directory name; `kind` is `device` or `widget`)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `roles?`                           | roles the module serves: its methods are rejected (409) on other roles, its status/settings/setup hooks only run on them, and its slice starts `enabled` on them. Omit for "every role".                                                                                                                                                                                                                                                                                                                  |
| `methodRoles?`                     | per-method role override (`{ "stream.start": ["combined"] }`)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `enabledByDefault?`                | `false` keeps the slice disabled on a fresh device even on its roles (opt-in modules)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `requireEnabled?`                  | reject the methods (409) while the slice is disabled                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `configKey?`                       | key of the slice under `settings.modules` (default `id`; `srtla` keeps its historical `relay` key)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `configDefaults?`                  | defaults of the slice, deep-merged under the stored values at every load (new fields backfill, stored values win)                                                                                                                                                                                                                                                                                                                                                                                         |
| `secretFields?`                    | slice fields the status masks as `{ configured }`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `methods`, `events`                | the RPC methods it answers and the events it emits (frozen API names)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `dispatch(method, params)`         | handle one call: validate `params` (throw `ApiError` from `shared/params`), act, return the result                                                                                                                                                                                                                                                                                                                                                                                                        |
| `log?`                             | log wording (`methods`, `reads`, `sections`, `labels`) merged into `shared/logMessages`; a method listed in `methods` is recorded in the event log and its response carries `logged: true`                                                                                                                                                                                                                                                                                                                |
| `dependencies?`                    | ids that must `start()` first; also orders status, resume and stop (reverse)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bind?(core)`                      | receive the process bag at discovery, before start (a disabled module is still bound, so lazy objects can report "stopped")                                                                                                                                                                                                                                                                                                                                                                               |
| `start({config, emit, log, core})` | bring the module up; `config` is its slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `stop()`                           | tear down (a no-op for a module that never started)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `resume?()`                        | autostart: resume the last saved run; `true` when something is running                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `status?()`                        | fragment deep-merged into the `status` payload; persisted bits go under `state`, device-list fields under `summary`                                                                                                                                                                                                                                                                                                                                                                                       |
| `settings?()`, `setupInfo?()`      | fields merged into `settings.get` / `setup.get`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `setup?(params, role)`             | first-run wizard: validate the module's answers and return the apply step; nothing is applied until every module validated                                                                                                                                                                                                                                                                                                                                                                                |
| `configure?(config, slice)`        | apply a `modules.configure` payload to the slice (default: only `enabled`); the module is restarted afterwards                                                                                                                                                                                                                                                                                                                                                                                            |
| `pages?`                           | `{ match: RegExp, page }[]` — the device-relative paths that serve `pages/<page>.html` (the control server mirrors them under `/d/<id>/`)                                                                                                                                                                                                                                                                                                                                                                 |
| `dashboardWidgets?`                | dashboard widget types with their default grid size (the server validates dashboards against them); a widget may declare `configFields` and a `validateConfig(config, context)` hook for a server-validated config, and `fleet: true` for a widget offered once that names its devices in that config instead of binding to one                                                                                                                                                                           |
| `dashboardActions?`                | operator actions offered to the dashboard **Buttons** widget: `{ id, label, icon?, method, params?, confirm?, roles? }[]` — `method` must be one of `methods`. May instead be a `status => …` factory for actions that depend on live device state (e.g. one button per OBS audio source); the registry resolves it against the freshest status. The control server merges the enabled modules' actions into the device's cached status as `status.actions` (see [Dashboard actions](#dashboard-actions)) |
| `services?.capabilities`           | `{ "<name>": impl }` offered to other modules over the bus                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hub?`                             | channel-widget hub (`widgetType`, `snapshotKey`, `defaultSize`, `configFields`, `channelSpec`, `create`)                                                                                                                                                                                                                                                                                                                                                                                                  |

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
`DashboardWidgetModule` (dashboard widgets without a device card):
`kind: "dashboard"`, `id`, `dashboardWidgets` (device-bound) and/or
`fleetWidgets` — a `FleetDashboardWidget` is offered once, names the devices
it drives in its config (`devicesFor(widget)`) and renders with a
`FleetDashboardContext` (`devices`, `link(deviceId)` → device, status, rpc);
the Buttons widget composes other modules' actions across devices this way.
Both widget shapes may bring their own config editor
(`configEditor(context, values)` + `configError`) instead of the generic
per-field form.

Core pages compose contributions; they contain no widget-type switches, no
module status fields and no imports from `modules/*`. Frontend modules talk to
each other through the per-connection `DeviceCard` capability API
(`host.provideCapability` / `host.getCapability`), never by import.

## Dashboard actions

The **Buttons** widget (`modules/buttons/`) is a virtual StreamDeck: a grid of
buttons on the dashboard, each firing one RPC method of one module on the
device it names — one widget (offered once per dashboard) can drive any number
of the user's devices. The widget never names a module — it reads each
device's **action catalogue** off `status.actions`, which the control server
merges from the registrations of every module that is enabled on that device
and serves its role (`backend/server/devices.ts` → `dashboardActionsFor` in
`shared/registry.ts`).

Declare actions on the backend registration; nothing else is needed:

```ts
// modules/<id>/backend.ts
const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: "encoder",
	// …
	methods: ["encoder.stop", "encoder.bitrate" /* … */],
	dashboardActions: [
		// id: unique within the module (the widget stores "<module>.<id>")
		// label: an i18n key from modules/<id>/i18n/*.json (or plain text)
		// method: one of `methods` (the registry rejects anything else at load)
		{
			id: "stop",
			label: "act.encoder.stop",
			icon: "⏹",
			method: "encoder.stop",
			confirm: true,
		},
		{
			id: "bitrate-low",
			label: "act.encoder.bitrate_low",
			icon: "▽",
			method: "encoder.bitrate",
			params: { maxBitrate: 1500 },
		},
	],
};
```

-   `params` are the defaults a press sends; the operator can override or
    complete them per button in the widget's settings (`paramsOverride` wins),
    so a method that needs operator-specific input (`encoder.start` needs
    `pipeline`, `host`, `port`) can still be a button.
-   `confirm: true` asks before firing.
-   `roles` scopes the action to device roles; it defaults to
    `methodRoles[method]`, then the module's `roles`. There is no user-level
    role model beyond device ownership — a dashboard only ever shows the
    user's own devices.
-   An action whose module gets disabled disappears from the catalogue on the
    next status; the widget shows such buttons (and buttons of a device that
    is no longer the user's) as unavailable and refuses to fire them. A
    dashboard save keeps them; creating a dashboard with unknown actions or
    foreign devices is rejected.

A `dashboardActions` factory is an alternative to a fixed list, for actions
that depend on the device's live state. The registry calls it with the device's
`status` on every status push, so the result tracks the device:

```ts
// modules/obs-controller/backend.ts — one mute button per live audio source
dashboardActions: (status) => [
	{ id: "stream-start", label: "act.obs.stream_start", icon: "▶", method: "obs.request", params: { requestType: "StartStream" } },
	// …
	...status.obs.audioSources.map((s) => ({
		id: `mute:${s.name}`,
		label: s.name, // a raw source name; the widget's t() renders it verbatim
		icon: s.muted ? "🔊" : "🔇",
		method: "obs.request",
		params: { requestType: "SetInputMute", requestData: { inputName: s.name, inputMuted: !s.muted } },
	})),
],
```

The factory runs on the **control server** (which never starts the device
module), so it must read the source list off `status` — the module publishes it
from `status()` (a module's `status()` fragments land at the top level of the
status). Return `[]` to hide a module from the catalogue for a given status.

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

| name           | provider | consumers       | shape                                                                                                        |
| -------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `net.uplinks`  | modems   | srtla           | `{ file, reconfigure() }` — the uplinks file `srtla_send` reads and the routing re-sync                      |
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
   optionally `frontend.tsx` (default-export a `FrontendModule`,
   `ChannelWidgetModule` or `DashboardWidgetModule` — only when the module
   has a device card, a dashboard widget or a setup step) and/or
   `settings.tsx` (a settings-page `ModuleDef`), plus `types.ts`,
   `styles.css`.
2. Declare `roles`, `methods`, `events`, the hooks you need, `log` wording,
   `pages` / `dashboardWidgets` / `dashboardActions`, and `dependencies` if
   it must start after another module.
3. Put the module's translations in `modules/<id>/i18n/<lang>.json` (all
   languages in `shared/languages.ts`) and its wire types in `types.ts`.
4. **No core edits** — the backend scan picks it up and `predev` regenerates
   the frontend, settings and i18n manifests.

Module method and event names are frozen: renaming one is a breaking API
change.
