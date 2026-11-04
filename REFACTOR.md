# REFACTOR — control server as pluggable page slices

Per `TODO/01-refactor.md`. The control server is now composed of
entity-agnostic core infrastructure plus pluggable page modules under
`server/pages/<id>/`. A new page is added by creating one directory — no
edits anywhere else (proved with a temporary `recordings` slice: manifest
regeneration + discovery + menu + route with zero edits outside the
directory).

## New layout

```
server/
├─ main.ts                     # CLI entry (was server/backend/server.ts)
├─ core/                       # entity-agnostic infrastructure
│  ├─ app.ts                   # composition: createServices → buildApp → discoverPages → mountRoutes → listen → start hooks
│  ├─ contracts.ts             # PageModule, MenuContribution, PageServices, ServerConfig, capabilities
│  ├─ registry.ts              # discoverPages / mountRoutes / getMenu / assertPageModule / capability map
│  ├─ services.ts              # db, auth, publish, config, frontend, capabilities
│  ├─ live_routes.ts           # /dashboards/ws shared live feed (consumed by 3 pages → core)
│  ├─ runtime.ts               # (was backend/contracts.ts) Socket/Publish/WsData/topics/event
│  ├─ socket.ts, db.ts, static_routes.ts
│  └─ auth/, migrations/
├─ shell/                      # control-server frontend, page-agnostic
│  ├─ nav.tsx                  # ServerNav rendered from generated/pages.ts MENUS
│  ├─ live.ts                  # (was frontend/ts/services/serverws.ts)
│  ├─ {login,register,profile}.tsx
│  └─ pages/{login,register,profile}.html
└─ pages/                      # the pluggable vertical slices
   ├─ devices/     index.ts, server/{registry,routes}.ts, client/{menu,device_list}.tsx, pages/device_list.html
   ├─ dashboards/ index.ts, server/{registry,routes}.ts, client/*, pages/dashboard_*.html
   ├─ overlays/   index.ts, server/{registry,routes}.ts, client/* (+overlay.css), pages/overlay_*.html
   └─ assets/     index.ts, server/{registry,routes}.ts, client/*, pages/assets_list.html
```

`shared/ui/` stays the UI atom layer; the module system
(`shared/registry.ts`, `scripts/gen_modules.ts`, `client/modules/`,
`server/modules/`) is untouched.

## Cross-page wiring

- Pages publish state in `server.init(s)` via `s.capabilities.provide(id, …)`
  and pull dependencies via `s.capabilities.require<T>(id)`.
- `dependencies: [ids]` gives topological init order (devices → dashboards,
  assets → overlays).
- Capabilities in use: `devices`, `dashboards`, `overlays`, `assets`.
- The module `controlRoutes(…)` (composed in `core/app.ts`) pulls the
  `dashboards` and `overlays` capabilities.
- The `/dashboards/ws` live feed is core (`core/live_routes.ts`): it serves
  the devices, dashboards and overlays pages, so it is not page-owned.
  Path unchanged.

## Manifests

`scripts/gen_pages.ts` scans `server/pages/*/client/menu.ts` →
`generated/pages.ts` (browser menu manifest) and `server/pages/*/index.ts`
→ `generated/pages.server.ts` (compiled-binary module list). Wired into
`predev`/`pretest`/`prebuild:*`; dev bootstrapping and `createFrontend`
re-run it. Both are gitignored (root `generated/`, the same sanctioned
door as the module manifests).

## File mapping (old → new)

| Old | New |
| --- | --- |
| `server/backend/server.ts` | `server/main.ts` |
| `server/backend/control_server.ts` | `server/core/app.ts` |
| `server/backend/contracts.ts` | `server/core/runtime.ts` |
| `server/backend/socket.ts` | `server/core/socket.ts` |
| `server/backend/db.ts` | `server/core/db.ts` |
| `server/backend/static_routes.ts` | `server/core/static_routes.ts` |
| `server/backend/auth/` | `server/core/auth/` |
| `server/backend/migrations/` | `server/core/migrations/` |
| `server/backend/devices/device_registry.ts` | `server/pages/devices/server/registry.ts` |
| `server/backend/devices/device_{list,connection,page,viewer}_routes.ts` | `server/pages/devices/server/routes.ts` |
| `server/backend/dashboards/dashboard_store.ts` | `server/pages/dashboards/server/registry.ts` |
| `server/backend/dashboards/dashboard_routes.ts` | `server/pages/dashboards/server/routes.ts` (+ `core/live_routes.ts`) |
| `server/backend/overlays/overlay_store.ts` | `server/pages/overlays/server/registry.ts` |
| `server/backend/overlays/overlay_routes.ts` | `server/pages/overlays/server/routes.ts` |
| `server/backend/assets/{asset_store,asset_routes,README}.ts` | `server/pages/assets/server/{registry,routes}.ts` (+README) |
| `server/frontend/ts/devices/device_list.tsx` | `server/pages/devices/client/device_list.tsx` |
| `server/frontend/ts/dashboards/*` | `server/pages/dashboards/client/*` |
| `server/frontend/ts/overlays/*` | `server/pages/overlays/client/*` |
| `server/frontend/ts/assets/*` | `server/pages/assets/client/*` |
| `server/frontend/ts/{login,register,profile}.tsx` | `server/shell/{login,register,profile}.tsx` |
| `server/frontend/ts/services/serverws.ts` | `server/shell/live.ts` |
| `server/frontend/pages/device_list.html` | `server/pages/devices/pages/device_list.html` |
| `server/frontend/pages/dashboard_*.html` | `server/pages/dashboards/pages/*.html` |
| `server/frontend/pages/overlay_*.html` | `server/pages/overlays/pages/*.html` |
| `server/frontend/pages/assets_list.html` | `server/pages/assets/pages/assets_list.html` |
| `server/frontend/pages/{login,register,profile}.html` | `server/shell/pages/*.html` |
| `server/frontend/css/overlay.css` | `server/pages/overlays/client/overlay.css` |
| `shared/ui/components/nav.tsx` (ServerNav) | `server/shell/nav.tsx` (deleted from shared/ui) |
| — (new) | `server/core/{contracts,registry,services}.ts`, `scripts/gen_pages.ts`, `test/pages_boundaries.test.ts` |

`server/backend/` and `server/frontend/` are deleted.

## Module relocation

The control server's widget/overlay modules now live inside the page slice that
consumes them — they are discovered by the same flat registry as before
(`shared/registry.ts`), just from a per-page directory. `server/modules/` is
deleted; the device modules (`client/modules/`) are untouched (a separate
process). `shared/paths.ts` `MODULE_ROOTS` gains the two page-module roots, and
`test/boundaries.test.ts` `LAYOUT.moduleRoots` mirrors it so the isolation
invariants still hold.

| Old | New | Consumed by |
| --- | --- | --- |
| `server/modules/chat/` | `server/pages/dashboards/modules/chat/` | dashboards widget + overlays chat elements + device chat route |
| `server/modules/deck/` | `server/pages/dashboards/modules/deck/` | dashboards (Buttons widget) |
| `server/modules/stats/` | `server/pages/dashboards/modules/stats/` | dashboards (Stats widget) |
| `server/modules/overlay_elements/` | `server/pages/overlays/modules/overlay_elements/` | overlays (built-in elements) |
| `server/modules/overlay_templates/` | `server/pages/overlays/modules/overlay_templates/` | overlays (template catalog) |

Mechanics:

- Every `../../..` (root-bound) import inside a moved module gains two levels
  (`../../../../..`) — modules moved from depth 3 to depth 5.
- Discovery is manifest-driven: `scripts/gen_modules.ts` globs
  `${root}/*/<file>` across `MODULE_ROOTS`, so the moved modules are picked up
  with no per-module path edits (backend/frontend/overlay elements/schemas).
- Page-slice code never imports its colocated modules directly — they reach
  pages only through the global registry and the generated manifests, so
  `test/pages_boundaries.test.ts` and `test/boundraries...` stay green with no
  rule changes.
- A page that gains a module adds `server/pages/<id>/modules` to
  `MODULE_ROOTS` (one line) — the scan, i18n merge, and generators all pick
  it up.

## CSS relocation

CSS now sits next to the code that uses it. `shared/css/` keeps only the shared
foundation (tokens, base, layout, `style.css`); the component CSS moved into the
UI kit and each page's CSS into the slice/shell/client that uses it.
`shared/css/style.css` is the single `<link>`ed entry every page loads — it
`@import`s the shared files, the UI component CSS, and the relocated page files
in the same cascade order as before (only the paths changed). Module CSS
(`styles.css`) was already collocated with its module above.

| Old | New |
| --- | --- |
| `shared/css/components/*.css` (11 files) | `shared/ui/components/*.css` |
| `shared/css/pages/dashboard.css` | `server/pages/dashboards/client/dashboard.css` |
| `shared/css/pages/overlay_editor.css` | `server/pages/overlays/client/overlay_editor.css` |
| `shared/css/pages/assets.css` | `server/pages/assets/client/assets.css` |
| `shared/css/pages/auth.css` | `server/shell/auth.css` |
| `shared/css/pages/profile.css` | `server/shell/profile.css` |
| `shared/css/pages/setup.css` | `client/frontend/setup.css` |

## Entry points

- `bun dev` / `Dockerfile` ENTRYPOINT / `run.sh` / `scripts/smoke.ts`:
  `bun server/main.ts` (flags unchanged).
- `build:server` compiles `server/main.ts`; the compiled binary loads the
  page list from `generated/pages.server.ts` (runtime directory scans are
  unavailable inside the Bun `/$bunfs` mount).

## Guards

- `test/pages_boundaries.test.ts`: every `server/pages/<id>/` is a valid
  PageModule (id === directory, via the runtime `assertPageModule`); no
  cross-page runtime imports; core/shared never value-import a page; the
  shell reaches only shell/core/shared/generated.
- `test/boundaries.test.ts` LAYOUT updated for the new roots.
- `test/pages.test.ts` SERVER_PAGES now lists only the shell pages; slice
  pages are discovered from `server/pages/*/pages/` by `shared/frontend.ts`.
- All URLs and WebSocket paths are byte-identical to the pre-refactor
  server.
