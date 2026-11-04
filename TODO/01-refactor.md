# Refactor control server into pluggable `pages/` slices

## 0. Mission

Refactor the **control server** of `github.com/majklovec/irlctrl` so that every top‑level entity — **Devices, Dashboards, Overlays, Assets** — becomes a self‑contained vertical slice under `server/pages/<entity>/`. The core must know nothing about any entity: adding a new entity must be a matter of creating one directory, not editing `control_server.ts`, the router, the menu, or any shared file.

The target architecture is already described in the previous design discussion. This document is the **implementation handoff**: what to read, what to build, in what order, and how to verify.

---

## 1. Repository and stack — confirm before coding

Stack (do not introduce new major dependencies):
- **Runtime:** Bun
- **Backend:** Elysia
- **Frontend:** Mithril
- **DB:** `bun:sqlite`
- **Build:** `bun run dev`, `bun test`, `bun run build:client`, `bun run build:server`

The control server already has a **module system** for device modules (`client/modules/`) and dashboard widget modules (`server/modules/`), discovered by `shared/registry.ts` and a generated manifest from `scripts/gen_modules.ts`. **Do not break it.** The new page system is parallel to, and separate from, that module system.

---

## 2. Reconnaissance — read these first

Clone the repo and read these files **before changing anything**. The agent must understand the current composition before slicing it.

| Area                   | Paths to inspect                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server composition** | `server/backend/control_server.ts`, `server/backend/server.ts`, `server/backend/contracts.ts`                                                                                                       |
| **Existing domains**   | `server/backend/devices/` (`device_registry.ts`, `*_routes.ts`), `server/backend/dashboards/` (`dashboard_store.ts`, `*_routes.ts`), `server/backend/overlays/` (`overlay_store.ts`, `*_routes.ts`) |
| **Infrastructure**     | `server/backend/db.ts`, `server/backend/auth/`, `server/backend/migrations/`                                                                                                                        |
| **Frontend shell**     | `server/frontend/`, `shared/frontend.ts`, `shared/ui/`, `shared/css/`, `shared/assets/`                                                                                                             |
| **Module registry**    | `shared/registry.ts`, `scripts/gen_modules.ts`, `test/registries.test.ts`                                                                                                                           |
| **Module contracts**   | `shared/contracts/backend_module.ts`, `shared/contracts/frontend_module.ts`                                                                                                                         |
| **Widget modules**     | `server/modules/` (dashboard widgets such as `server/modules/deck/`, `server/modules/chat/`)                                                                                                        |
| **Build scripts**      | `scripts/gen_control_server_assets.ts`, `package.json` (`predev`, `pretest`, `prebuild:*`)                                                                                                          |

Run these **before touching code**:

```bash
bun install
bun test                          # baseline must be green
bun run dev                       # smoke the control server UI
```

Also locate the current routes for each entity:

```bash
grep -R "new Elysia" server/backend --include="*.ts"
grep -R "\.get(\|\.post(\|\.ws(" server/backend --include="*_routes.ts"
```

The README confirms the current domain split already follows store/routes separation:
- `devices/` owns the device registry, connection, list, page and viewer routes.
- `dashboards/` owns validation, persistence and widget‑hub sync.
- `overlays/` owns OBS overlay projects and editor/runtime routes.
- Each domain directory holds `*_store.ts` / `*_registry.ts` and `*_routes.ts`; the composition layer supplies publishing and cross‑domain dependencies.

**Assets** may not yet be a top‑level domain; the `--storage` flag controls the asset directory. The agent must **verify** whether asset routes exist inside another domain (likely `server/backend/assets/` or under `server/modules/`) and decide whether Assets is already a page or needs to be extracted as one. If no asset page exists, create the slice only if the UI has an assets surface; otherwise leave it out and document why.

---

## 3. Target architecture — `server/pages/`

Create this structure. The old `server/backend/` and `server/frontend/` folders are **not** kept as top‑level layers; their contents move into `core/`, `ui/`, `shell/`, and the relevant `pages/*/` slice.

```
server/
├─ main.ts                          # new bootstrap (or keep server/backend/server.ts as CLI, but delegate)
│
├─ core/                            # entity-agnostic infrastructure
│  ├─ contracts.ts                  # PageModule, MenuContribution, PageServices
│  ├─ services.ts                   # db, auth, event bus, config factory
│  ├─ registry.ts                   # runtime discovery + composition of pages
│  ├─ app.ts                        # Elysia app factory (middleware only, no page routes)
│  └─ generated/
│     └─ pages.ts                   # build-time manifest for the browser (gitignored)
│
├─ ui/                              # shared frontend atoms — no page knowledge
│  ├─ button.tsx
│  ├─ modal.tsx
│  └─ layout_primitives.tsx
│
├─ shell/                           # frontend shell — no page knowledge
│  ├─ app.tsx                       # layout + Mithril router bootstrap
│  ├─ router.ts                     # builds route map from page registry
│  ├─ menu.tsx                      # renders menu from page registry
│  ├─ layout.tsx
│  └─ styles.css
│
└─ pages/
   ├─ devices/
   │  ├─ index.ts                   # export default PageModule — the only public entry
   │  ├─ server/
   │  │  ├─ routes.ts               # Elysia plugin (moved from server/backend/devices/*_routes.ts)
   │  │  ├─ registry.ts             # device registry logic (moved from device_registry.ts)
   │  │  └─ events.ts               # page-local bus topics
   │  ├─ client/
   │  │  ├─ page.tsx                # Mithril page component
   │  │  ├─ menu.ts                 # menu contribution
   │  │  ├─ store.ts                # page-local client state / API calls
   │  │  └─ components/             # UI only used by this page
   │  ├─ shared/
   │  │  └─ types.ts                # DTOs shared by this page’s server and client
   │  └─ test/
   │     └─ devices.test.ts
   │
   ├─ dashboards/  { same shape }
   ├─ overlays/    { same shape }
   └─ assets/      { same shape — only if an assets surface exists }
```

**Dependency rule (must be enforced by a test):**

```
pages/*  ──▶  shell/  ──▶  ui/  ──▶  external
   │
   └──────▶  core/  ──▶  external
```

- `core/` and `ui/` **must not import** from `pages/` or `shell/`.
- `shell/` talks to pages **only through `core/registry.ts`** — never imports a page directory directly.
- `pages/X/` **must not import** from `pages/Y/`.

---

## 4. Contracts — the only surface the core knows

Create `server/core/contracts.ts`. This contract covers both server and client contributions; there is no separate backend contract.

```ts
// server/core/contracts.ts
import type { Elysia } from "elysia";
import type { Component } from "mithril";

export interface MenuContribution {
	id: string; // must equal the page directory name
	label: string;
	path: string; // e.g. "/devices"
	icon?: string;
	order?: number; // menu sorting
}

export interface PageServices {
	db: Database; // bun:sqlite
	auth: AuthService; // session / token resolution
	publish: (topic: string, payload: unknown) => void;
	config: ServerConfig;
}

export interface PageModule {
	id: string;
	menu: MenuContribution;

	server: {
		routes: Elysia; // Elysia plugin
		init?: (s: PageServices) => void | Promise<void>;
	};

	client: {
		page: Component; // Mithril component
	};
}
```

Do **not** reuse the existing `shared/contracts/backend_module.ts` / `frontend_module.ts` for pages. Those contracts describe _modules_, not _pages_. Reusing them would conflate the two plugin systems.

---

## 5. Page registry — discovery and composition

`server/core/registry.ts` is the **only** file that knows the physical `pages/` layout.

```ts
// server/core/registry.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PageModule, PageServices, MenuContribution } from "./contracts";

const ROOT = new URL("../pages", import.meta.url).pathname;
let pages: PageModule[] = [];
let ready = false;

export async function discoverPages(
	services: PageServices,
): Promise<PageModule[]> {
	if (ready) return pages;

	const found: PageModule[] = [];
	for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

		const mod = await import(join(ROOT, entry.name, "index.ts"));
		const page = mod.default as PageModule;

		if (!isPageModule(page)) {
			console.warn(`[pages] ${entry.name}: missing PageModule default export`);
			continue;
		}
		if (page.id !== entry.name) {
			throw new Error(
				`Page id "${page.id}" must match directory "${entry.name}"`,
			);
		}
		await page.server.init?.(services);
		found.push(page);
	}

	pages = found.sort((a, b) => (a.menu.order ?? 100) - (b.menu.order ?? 100));
	ready = true;
	return pages;
}

export function getPages(): PageModule[] {
	if (!ready) throw new Error("discoverPages must be called first");
	return pages;
}

export function getMenu(): MenuContribution[] {
	return getPages().map((p) => p.menu);
}

export function mountRoutes(app: Elysia): void {
	for (const p of getPages()) app.use(p.server.routes);
}

function isPageModule(x: unknown): x is PageModule {
	return (
		!!x &&
		typeof x === "object" &&
		"id" in x &&
		"menu" in x &&
		"server" in x &&
		"client" in x
	);
}
```

**Important:** this registry scans `server/pages/`, **not** `client/modules/` or `server/modules/`. The existing `shared/registry.ts` must continue to handle module discovery unchanged.

### Browser discovery — generated manifest

Bun can call `readdirSync` on the server, but the browser bundle cannot. Create `scripts/gen_pages.ts` modeled on `scripts/gen_modules.ts`:
- Scan `server/pages/*/client/page.tsx` and `server/pages/*/client/menu.ts`.
- Write `server/core/generated/pages.ts` (gitignored) that statically imports each page component and menu contribution.
- Export an array of `PageModule`‑shaped objects with `server` stubbed.
- Wire it into `predev`, `pretest`, and `prebuild:*` in `package.json`, mirroring the existing `gen_modules.ts` wiring.

The shell must import **only the generated manifest**, never the file system.

---

## 6. Example slice — Devices

Implement Devices first as the reference slice. Every other page follows the same shape.

```ts
// server/pages/devices/index.ts
import type { PageModule } from "../../core/contracts";
import { routes } from "./server/routes";
import { DevicesPage } from "./client/page";
import { menu } from "./client/menu";

const devices: PageModule = {
	id: "devices",
	menu,
	server: { routes },
	client: { page: DevicesPage },
};

export default devices;
```

```ts
// server/pages/devices/client/menu.ts
import type { MenuContribution } from "../../../core/contracts";

export const menu: MenuContribution = {
	id: "devices",
	label: "Devices",
	path: "/devices",
	icon: "device",
	order: 10,
};
```

```ts
// server/pages/devices/server/routes.ts
import { Elysia } from "elysia";
import { listDevices, getDevice } from "./registry";

export const routes = new Elysia({ prefix: "/devices" })
	.get("/", ({ user }) => listDevices(user.id))
	.get("/:id", ({ params, user }) => getDevice(params.id, user.id));
```

```tsx
// server/pages/devices/client/page.tsx
import m from "mithril";
import { deviceStore } from "./store";
import { DeviceCard } from "./components/device_card";

export const DevicesPage = {
	oninit: () => deviceStore.load(),
	view: () =>
		m(".devices-page", [
			m("h1", "Devices"),
			deviceStore.devices.map((d) => m(DeviceCard, { device: d })),
		]),
};
```

**Mapping from current code:**

| Current                                                            | New                                       |
| ------------------------------------------------------------------ | ----------------------------------------- |
| `server/backend/devices/device_registry.ts`                        | `server/pages/devices/server/registry.ts` |
| `server/backend/devices/*_routes.ts`                               | `server/pages/devices/server/routes.ts`   |
| Device page component under `server/frontend/` (locate exact file) | `server/pages/devices/client/page.tsx`    |
| Device menu entry in shell/menu                                    | `server/pages/devices/client/menu.ts`     |
| Device wire types                                                  | `server/pages/devices/shared/types.ts`    |
| Device tests                                                       | `server/pages/devices/test/`              |

Repeat the same mapping for `dashboards` (`dashboard_store.ts` → `pages/dashboards/server/store.ts`) and `overlays` (`overlay_store.ts` → `pages/overlays/server/store.ts`).

---

## 7. Shell — thin and page‑agnostic

Create `server/shell/router.ts` and `server/shell/menu.tsx`. They import the registry, never a page directory.

```ts
// server/shell/router.ts
import { getPages } from "../core/registry";

export function buildRoutes() {
	return Object.fromEntries(
		getPages().map((p) => [p.menu.path, p.client.page]),
	);
}
```

```tsx
// server/shell/menu.tsx
import m from "mithril";
import { getMenu } from "../core/registry";

export const Menu = {
	view: () =>
		m(
			"nav",
			getMenu().map((item) => m(m.route.Link, { href: item.path }, item.label)),
		),
};
```

`server/shell/app.tsx` wires the layout and calls `m.route(document.body, "/devices", buildRoutes())`.

If the existing `shared/frontend.ts` already bundles the UI, **adapt it** rather than replacing it wholesale: it should import the generated page manifest and pass the route map to Mithril. Do not duplicate bundling logic.

---

## 8. Core bootstrap — no entity names

Refactor the composition so `server/backend/control_server.ts` (or a new `server/main.ts`) contains **no device/dashboard/overlay/assets names**.

```ts
// server/main.ts (sketch)
import { buildApp } from "./core/app";
import { discoverPages, mountRoutes } from "./core/registry";
import { createServices } from "./core/services";

const services = createServices(); // db, auth, publish, config
await discoverPages(services);

const app = buildApp(services); // Elysia + middleware only
mountRoutes(app); // pages contribute their own routes
app.listen(8090);
```

Cross‑page infrastructure — auth middleware, WebSocket transport, event bus, maintenance timers — moves to `core/` or stays in `core/app.ts`. Page‑specific WebSocket topics belong in `pages/<id>/server/events.ts` and are registered by that page’s `init`.

---

## 9. Migration plan — one slice at a time, tests green at every step

Do not attempt a big‑bang rewrite. Use a feature branch and keep `bun test` green after each phase.

### Phase 0 — Baseline and skeleton (no behaviour change)

1. Clone, `bun install`, `bun test`, `bun run dev`. Record the baseline.
2. Create `server/core/contracts.ts`, `server/core/registry.ts`, `server/core/app.ts`, `server/core/services.ts`.
3. Create `server/ui/` and `server/shell/` with placeholder layout, router and menu.
4. Add `scripts/gen_pages.ts` and wire it into `package.json`.
5. **Do not move any page code yet.** The existing `control_server.ts` still works.

### Phase 1 — Devices slice (reference implementation)

1. Move device server logic and routes into `server/pages/devices/server/`.
2. Move the device page component into `server/pages/devices/client/page.tsx`.
3. Extract the device menu contribution.
4. Add `server/pages/devices/index.ts`.
5. Update `control_server.ts` to stop mounting device routes directly; call `discoverPages()` + `mountRoutes()` for devices only, while other routes remain hand‑mounted.
6. Update the shell to render devices from the registry.
7. Run `bun test` and smoke‑test `/devices`, device list, device page, device WebSocket.

### Phase 2 — Dashboards and Overlays

Repeat the same steps for `dashboards` and `overlays`. By the end of this phase, `control_server.ts` should have **zero** page‑specific route mounting; it only calls `discoverPages` and `mountRoutes`.

### Phase 3 — Assets (conditional)

Inspect whether an assets UI surface exists. If it does, create `server/pages/assets/` with its storage routes and page. If it does not, document that Assets remains a backend capability without a page, and **do not** create an empty slice.

### Phase 4 — Remove legacy layers

1. Delete empty `server/backend/` and `server/frontend/` directories once nothing lives there.
2. Ensure `server/backend/server.ts` (CLI entry) delegates to `server/main.ts` or is moved to `server/main.ts` with the CLI flags preserved.
3. Keep the existing module system (`client/modules/`, `server/modules/`, `shared/registry.ts`, `gen_modules.ts`) untouched.

### Phase 5 — Boundary enforcement

Add `test/pages_boundaries.test.ts` (or extend `test/registries.test.ts`) that asserts:
1. Every directory in `server/pages/` exports a valid `PageModule` with `id === directoryName`.
2. No file under `server/pages/X/` imports from `server/pages/Y/`.
3. `server/core/` and `server/ui/` do not import from `server/pages/` or `server/shell/`.
4. `server/shell/` imports only `server/core/` (plus `ui/`), never a page directory.

Use a lightweight static import‑graph scan (regex over `import … from "…"`) — no new dependency needed.

---

## 10. Verification checklist

Run after every phase, and again at the end.

### Automated

```bash
bun test
bun run build:client
bun run build:server
```

- All existing tests pass, including `test/registries.test.ts`.
- New boundary test passes.
- `bun run build:server` produces a standalone binary that starts and serves the UI.
- `bun run build:client` produces a device binary (unchanged behaviour).

### Manual smoke

1. `bun run dev` → open control server UI.
2. Menu shows **Devices, Dashboards, Overlays** (and **Assets** if implemented).
3. Navigate to each page; the URL, layout and data match the pre‑refactor behaviour.
4. Device list, device page, device WebSocket (`/devices/:id/ws` or the existing path) work.
5. Dashboard create/edit/view and dashboard WebSocket work.
6. Overlay editor and runtime routes work.
7. Authentication (`/login`, `/register`, `/profile`) still works — auth stays in `core/`, so this is a regression check.
8. The existing module system still discovers device modules and dashboard widgets; do **not** change `shared/registry.ts` or `scripts/gen_modules.ts`.
9. Generated page manifest exists and the browser bundle builds without runtime `readdirSync` errors.

### “Plug‑a‑new‑page” proof

Create a temporary empty `server/pages/recordings/` with:
- `index.ts` exporting a minimal `PageModule` (menu + a stub `Elysia` plugin + a Mithril component).
- `client/menu.ts` and `client/page.tsx`.
- `server/routes.ts`.

Run `bun run dev` **without editing any file outside `server/pages/recordings/`**. The menu item and route should appear. Delete the directory afterwards. If this works, the refactor meets its goal.

---

## 11. Pitfalls and constraints

- **Do not conflate page registry with module registry.** `shared/registry.ts` scans `client/modules/` and `server/modules/` and is wired into `gen_modules.ts`. The new `core/registry.ts` scans `server/pages/` only. Both systems coexist.
- **Snake_case file naming.** The repo uses snake_case (`control_server.ts`, `device_registry.ts`, `dashboard_store.ts`). Follow it.
- **Preserve CLI flags and environment variables.** The control server’s `--port`, `--db`, `--storage`, `--no-auth`, etc. must keep working. The bootstrap can move, but behaviour must not change.
- **WebSocket paths.** Device and dashboard WebSockets are existing clients; keep their paths stable. If a page owns a WebSocket, mount it from that page’s `routes.ts` with the same prefix.
- **Compiled assets.** `gen_control_server_assets.ts` embeds the UI into the server binary. Update it to include the generated page manifest and shell, or ensure the shell imports the manifest that this script already bundles.
- **Auth dependencies.** `core/services.ts` must supply `auth`, `db`, `publish` and `config` to pages. Do not let pages import `server/backend/auth/` directly; inject through `PageServices`.
- **Circular imports.** `core/registry.ts` imports page `index.ts` files dynamically; page files must not import `core/registry.ts`. If a page needs services, receive them via `init(services)` or through Elysia context.
- **No empty slices.** If Assets has no UI, do not create `pages/assets/` just to match the plan. Document the decision.

---

## 12. Deliverables

A pull request containing:
1. `server/core/` with contracts, registry, services, app factory.
2. `server/ui/` with shared atoms extracted from `shared/ui/` or `server/frontend/` (only what pages actually need).
3. `server/shell/` with layout, router, menu, and the updated Mithril bootstrap.
4. `server/pages/devices/`, `server/pages/dashboards/`, `server/pages/overlays/` fully populated, plus `assets/` if applicable.
5. `scripts/gen_pages.ts` wired into `package.json`.
6. `test/pages_boundaries.test.ts` enforcing the dependency rule.
7. `server/main.ts` (or updated CLI entry) that composes only through the registry.
8. Removal of page‑specific code from `server/backend/control_server.ts` and the old `server/frontend/` page mounting.
9. A short `REFACTOR.md` or PR description mapping old paths to new paths, listing verification commands and the “empty `recordings/` slice” proof.

**Definition of done:** `bun test` green, both binaries build, manual smoke passes, the boundary test passes, and creating a new page directory requires zero edits outside that directory.
