# Donation Hub Page — Implementation Handoff (post-refactor architecture)

## 0. Context

This handoff supersedes the original `Donation Hub Module` brief. The control server has been refactored into a **vertical-slice `pages/` architecture**:
- Every top-level entity is a self-contained slice under `server/pages/<entity>/` exporting a **`PageModule`** (from `server/core/contracts.ts`).
- Discovery and composition happen through **`server/core/registry.ts`** (runtime) and a generated manifest (browser).
- Shared infrastructure lives in `server/core/`, `server/ui/` and `server/shell/`. Pages must not import each other.
- The legacy `server/modules/` and `client/modules/` systems (device modules, dashboard widgets) are **unchanged** and still exist. The Donation Hub will **not** be implemented as a legacy module — it becomes a **page slice**.

Read the refactor handoff before starting. The Donation Hub is the first _new_ page to be added after the refactor, so it doubles as the proof that "adding a page touches nothing outside its own directory" — except for the three small additive core extensions listed in §4.

---

## 1. Objective

Implement a **donation hub** as a first-class page slice under `server/pages/donations/`. It must:
- Accept webhooks from **Ko-fi, Stripe, ComGate, StreamElements** via a unified set of routes owned by the slice (`/webhook/donations/*`).
- Normalize every incoming payment into a single internal `DonationEvent`.
- Publish alerts to the **dashboard** WebSocket feed (topic `dashboards`) and to the **overlay runtime** WS so donation-alert overlays trigger automatically.
- Expose its own HTTP surface for configuration and history under `/donations/*`.
- Register a new overlay element type `"donation-alert"` via the page contract (see §4.1).
- Ship its own Mithril page at `/donations` (config + recent donations list) and its own menu contribution.

No edits to files outside `server/pages/donations/` except the three additive core extensions in §4.

---

## 2. Repository context (post-refactor)

| Area                         | Key facts                                                                                                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**                  | Bun (`bun:sqlite`, native `fetch`, native `WebSocket`). No Express, no `ws`, no `better-sqlite3`.                                                                                                                                                                      |
| **Page root**                | `server/pages/`. Each subdirectory exporting `index.ts` with a default `PageModule` is auto-discovered.                                                                                                                                                                |
| **Page contract**            | `server/core/contracts.ts` — `PageModule` (`id`, `menu`, `server.routes`, `server.init`, `client.page`, plus the new `overlayElements` field from §4.1).                                                                                                               |
| **Services bag**             | `PageServices` — `db`, `auth`, `publish(topic, payload)`, `config` (plus the `onShutdown`/`dashboard` helpers in §4.3). Injected via `server.init(services)`.                                                                                                          |
| **Routing**                  | `server.routes` is an Elysia plugin. Mounted by `server/core/registry.ts → mountRoutes(app)`. Paths must be unique across pages.                                                                                                                                       |
| **Bus & WS**                 | `services.publish(topic, payload)` publishes to the topic's WS broadcast. Dashboard topic: `dashboards` on `/dashboards/ws`. Overlay topic: `overlay-runtime` on `/overlay/:id/ws?token=…`.                                                                            |
| **Overlay alert trigger**    | `GET /overlay/alert/<eventName>?token=…` is the existing entry point for on-air alerts. The new page contributes the `donation-alert` element, and the pipeline calls this endpoint with `eventName=donation`.                                                         |
| **Overlay element contract** | Schema half: `shared/contracts/overlay_element.ts`. Browser half: `shared/ui/overlay/element.ts`. Both are reusable as-is; the page contributes them through `PageModule.overlayElements`.                                                                             |
| **Discovery**                | Runtime `readdirSync` in `server/core/registry.ts`. Browser side imports `server/core/generated/pages.ts` (from `scripts/gen_pages.ts`). Adding `server/pages/donations/` and running `bun run gen:pages` (auto-invoked from `predev`/`pretest`) is all that's needed. |
| **Auth**                     | Webhook routes under `/webhook/*` are unauthenticated (see §6 and §9 Q1). `/donations/*` management routes require the normal session middleware.                                                                                                                      |
| **Tests**                    | `bun test`. Boundary test `test/pages_boundaries.test.ts` enforces the import rule. Page-local tests under `server/pages/donations/test/`.                                                                                                                             |
| **Frozen API**               | Once shipped, these names are frozen: HTTP routes (`/webhook/donations/*`, `/donations/*`), bus topic `donations.alert` and its payload shape, overlay element type `"donation-alert"`, config field names in `GET/POST /donations/config`.                            |

---

## 3. Slice layout

```
server/pages/donations/
├── index.ts                       # export default PageModule
├── server/
│   ├── routes.ts                  # Elysia plugin: /donations/* and /webhook/donations/*
│   ├── init.ts                    # init(services): open WS listeners, restore config
│   ├── store.ts                   # bun:sqlite: donations table, config store
│   ├── dispatcher.ts              # persist → translate → publish → overlay trigger
│   ├── alert_translator.ts        # DonationEvent → DonationAlert
│   ├── events.ts                  # bus topic + payload shape constants
│   └── plugins/
│       ├── kofi.ts
│       ├── stripe.ts
│       ├── comgate.ts
│       └── streamelements.ts
├── client/
│   ├── page.tsx                   # Mithril page: config form + recent donations
│   ├── menu.ts                    # MenuContribution
│   ├── store.ts                   # client state / API calls to /donations/*
│   └── components/
│       ├── donation_row.tsx
│       └── plugin_toggle.tsx
├── overlay/
│   ├── schema.ts                  # OverlayElementSchema for "donation-alert"
│   └── element.tsx                # OverlayElementDef (browser half)
├── shared/
│   ├── types.ts                   # DonationEvent, DonationAlert, wire shapes
│   └── config.ts                  # config field definitions (secret flags)
├── i18n/
│   ├── en.json
│   └── cs.json
├── test/
│   ├── donations.test.ts
│   └── fixtures/
│       ├── kofi.json
│       ├── stripe.json
│       └── comgate.json
└── README.md
```

Notes:
- **Server-only code stays under `server/`.** Nothing under `client/` imports `server/` or `bun:sqlite`.
- **`shared/` is the only cross-side import path.** Both sides import `shared/types.ts` and `shared/config.ts`.
- **`overlay/` is a third sibling**, not a subdirectory of `client/`, because the schema half runs in the server bundle (it feeds the overlay editor) while the element half runs in the browser runtime. Both are declared through the same `overlayElements` contribution (§4.1).
- **No imports from other pages.** If donations ever need device or dashboard data, it goes through `services.db` (queries) or a bus topic — never `import ... from "../devices/..."`.

---

## 4. Required additive core changes (three small ones)

The refactor intentionally leaves these out until a page actually needs them. Donations is the first page that does. Each is a **minimal, additive change** to `server/core/` — no breaking changes.

### 4.1 `PageModule.overlayElements` (overlay element contribution)

Extend `server/core/contracts.ts`:

```ts
import type { OverlayElementSchema } from "../../shared/contracts/overlay_element";
import type { OverlayElementDef } from "../../shared/ui/overlay/element";

export interface OverlayElementContribution {
	schema: OverlayElementSchema;
	element: OverlayElementDef;
}

export interface PageModule {
	id: string;
	menu: MenuContribution;
	server: { routes: Elysia; init?: (s: PageServices) => void | Promise<void> };
	client: { page: Component };
	overlayElements?: OverlayElementContribution[]; // ← new
}
```

Extend `server/core/registry.ts`:

```ts
export function getOverlayElements(): OverlayElementContribution[] {
	return getPages().flatMap((p) => p.overlayElements ?? []);
}
```

And have the existing overlay element aggregation (in `shared/ui/overlay/` or wherever it lives today — locate it via `grep -R "OverlayElementDef" shared/ server/`) call `getOverlayElements()` in addition to the legacy module-sourced elements.

Browser side: `scripts/gen_pages.ts` already imports each page's `frontend/page.tsx` and `frontend/menu.ts`. Extend it to also import `overlay/schema.ts` and `overlay/element.tsx` **if present** (existence check, so pages without overlay elements still work). It writes them into `server/core/generated/pages.ts` for the browser bundle.

### 4.2 `init` must support cleanup (WebSocket listener)

`server/init.ts` opens a long-lived `WebSocket` to StreamElements (§7.4). It needs to be closeable. Two acceptable shapes — pick the one the core supports today, or add the first:

```ts
// Option A — init returns a disposer
export type PageInit = (
	s: PageServices,
) => void | Promise<void> | (() => void | Promise<void>);

// Option B — services.onShutdown
export interface PageServices {
	// ...
	onShutdown: (fn: () => void | Promise<void>) => void;
}
```

`server/core/registry.ts` calls the disposer (or fires `onShutdown` handlers) when the server shuts down. If neither exists today, add **Option B** — it is the least invasive and also useful for future pages with timers.

### 4.3 `PageServices.dashboard` helper (optional but recommended)

The dashboard topic uses a specific envelope: `{ type: "event", event, data, module }`. Rather than asking every page to reconstruct it, add a thin helper:

```ts
export interface PageServices {
	// ...
	dashboard: {
		emit(
			event: string,
			data: unknown,
			opts?: { retain?: boolean; summary?: unknown },
		): void;
	};
}
```

Internally this calls `publish("dashboards", { type: "event", event, data, module })`. If the core already has a similar helper on `services.publish` (e.g. a `dashboards.publish` sub-service), use that instead and skip this addition.

The overlay WS publication does **not** need a new helper — the dispatcher will call the existing `GET /overlay/alert/donation?token=…` endpoint via `fetch()`, which is how the current alert pipeline works.

---

## 5. Page entry point

```ts
// server/pages/donations/index.ts
import type { PageModule } from "../../core/contracts";
import { routes } from "./server/routes";
import { init } from "./server/init";
import { DonationsPage } from "./client/page";
import { menu } from "./client/menu";
import { schema } from "./overlay/schema";
import { element } from "./overlay/element";

const donations: PageModule = {
	id: "donations",
	menu,
	server: { routes, init },
	client: { page: DonationsPage },
	overlayElements: [{ schema, element }],
};

export default donations;
```

```ts
// server/pages/donations/frontend/menu.ts
import type { MenuContribution } from "../../../core/contracts";

export const menu: MenuContribution = {
	id: "donations",
	label: "Donations",
	path: "/donations",
	icon: "heart",
	order: 40, // after devices(10), dashboards(20), overlays(30); assets(50)
};
```

---

## 6. Server side

### 6.1 HTTP routes (`backend/routes.ts`)

One Elysia plugin, one prefix, all routes owned by the slice.

```ts
// server/pages/donations/backend/routes.ts
import { Elysia } from "elysia";
import { handleKofi } from "./plugins/kofi";
import { handleStripe } from "./plugins/stripe";
import { handleComgate } from "./plugins/comgate";
import { dispatch } from "./dispatcher";
import { getRecent, getConfig, updateConfig, getStatus, replay } from "./store";

export const routes = new Elysia()
	// ---- webhooks (unauthenticated, see §9 Q1) ----
	.post("/webhook/donations/kofi", async ({ request }) => {
		const event = await handleKofi(request);
		return dispatch(event);
	})
	.post("/webhook/donations/stripe", async ({ request }) => {
		const event = await handleStripe(request);
		return dispatch(event);
	})
	.post("/webhook/donations/comgate", async ({ request }) => {
		const event = await handleComgate(request);
		return dispatch(event);
	})
	// ---- management (authenticated) ----
	.get("/donations/recent", ({ user }) => getRecent(user.id))
	.get("/donations/config", ({ user }) => getConfig(user.id))
	.post("/donations/config", ({ user, body }) => updateConfig(user.id, body))
	.get("/donations/status", ({ user }) => getStatus(user.id))
	.post("/donations/replay", ({ user, body }) => replay(user.id, body));
```

**Auth boundary.** The `/webhook/donations/*` routes must bypass the session middleware. Check how existing unauthenticated routes do it (the `chat` overlay server and the device WS handler are the references — `grep -R "withoutAuth\|skipAuth\|/overlay/" server/`). If the core uses a path-prefix skip (`/webhook/*`), nothing extra is needed; otherwise add `.derive`‑free scoping per the pattern in use.

**Raw body for Stripe.** Inside `handleStripe`, call `await request.text()` **before** any JSON parsing. Do not use the Elysia `body` shortcut on this route — pass `request` straight to the plugin.

**Idempotency.** Every webhook handler returns `200` with `{ ok: true, id }` on success and `{ ok: false, reason }` for rejected signatures / failed re-verification. The dispatcher does the insert-or-ignore; the HTTP layer stays simple.

### 6.2 Dispatcher (`server/dispatcher.ts`)

```ts
export async function dispatch(event: DonationEvent | null): Promise<Response> {
	if (!event) return json({ ok: false, reason: "rejected" }, 400);

	const inserted = insertDonation(event); // INSERT OR IGNORE
	if (!inserted) return json({ ok: true, id: event.id, deduped: true });

	const alert = translate(event, currentConfig());
	publishDashboardAlert(alert); // services.dashboard.emit(...)
	await triggerOverlayAlerts(event, alert); // GET /overlay/alert/donation?token=…
	return json({ ok: true, id: event.id });
}
```

On every normalized event the dispatcher:
1. Persists via `store.insertDonation(event)` — `INSERT OR IGNORE` on the primary key `${platform}:${event.id}` for idempotency.
2. Translates via `alert_translator.translate(event, config)` (§6.4).
3. Publishes to the dashboard bus via `services.dashboard.emit("donations.alert", alert, { retain: true, summary: { lastDonationAt, totalCount } })` (or the raw `publish("dashboards", …)` form if §4.3 is skipped).
4. Triggers overlay alerts (§6.5).

No outbound HTTP webhooks — everything is internal.

### 6.3 Persistence (`server/store.ts`)

**Database choice** (see §9 Q2): use a page-local `bun:sqlite` file at `config.dbPath`-derived path `donations.db` (same directory as the control server DB). Rationale: audit volume grows unbounded; keeping it separate from the control server DB avoids bloating backups and lets the file be rotated independently. Expose `closeDb()` from `store.ts` and register it via `services.onShutdown`.

Schema:

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS donations (
  id           TEXT PRIMARY KEY,       -- "${platform}:${event.id}"
  platform     TEXT NOT NULL,
  donor_name   TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,       -- haléře
  currency     TEXT NOT NULL,
  message      TEXT,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  raw_json     TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_donations_received_at ON donations(received_at DESC);

CREATE TABLE IF NOT EXISTS donations_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`getRecent(userId)` returns the last 50 rows; the config store reads/writes the `donations_config` table as a small key-value map (whole config blob under key `"current"`). Secrets are persisted but never returned raw — `getStatus` masks them (§7.1).

### 6.4 Alert translator (`server/alert_translator.ts`)

Implements the rules from the original brief:

```ts
export interface DonationAlert {
	id: string; // `${platform}:${event.id}`
	level: "donation" | "big-donation" | "subscription" | "milestone";
	title: string; // "New donation"
	body: string; // "Jan sent 150.00 CZK: Keep it up!"
	display: {
		donorName: string;
		amountFormatted: string;
		message?: string;
		platform: string;
	};
	ttsText: string; // diacritics stripped
	sound: string; // "donation-czk" | "donation-big"
	durationMs: number; // 5_000 | 10_000
	timestamp: string;
	source: DonationEvent;
}
```

Rules:
- `level = "big-donation"` when `amount_minor >= config.bigDonationThreshold` (default `50_000` haléřů = 500 CZK).
- `level = "subscription"` when `is_recurring === true`.
- `ttsText` is the display body with diacritics removed and currency expanded (`"150 Kč"` → `"150 korun"`). Keep the original `body` for display.
- `sound` = `"donation-big"` for `big-donation`, else `"donation-czk"`. This key is resolved by the overlay element against the user's asset library.
- `durationMs` = `10_000` for `big-donation`, else `5_000`.

### 6.5 Overlay trigger

The overlay element's `Event` prop is `"donation"`, so the existing pipeline `GET /overlay/alert/donation?token=…` fires it. The dispatcher just needs to call this endpoint once per **active overlay that contains a `donation-alert` element**.

Two options (see §9 Q3):
- **(a) Broadcast via overlay-runtime WS** — publish the alert on `overlay-runtime` and let each overlay runtime page filter. Simpler, no cross-page DB lookups, and consistent with the "pages don't talk to pages" rule. **Recommended default.**
- **(b) Look up overlays with the element and call `GET /overlay/alert/donation?token=…` per overlay** — requires DB access to the overlays table, which crosses the slice boundary (via `services.db` query only — no import). Acceptable if the runtime WS broadcast isn't currently set up.

Implement (a) first. If the overlay runtime WS doesn't support broadcast frames today, land (b) as a follow-up in `dispatcher.ts` with a single query via `services.db`:

```sql
SELECT id, runtime_token FROM overlays
WHERE json_extract(config_json, '$.elements[*].type') LIKE '%donation-alert%'
  AND user_id = ?;
```

Either way, pass the alert fields as query parameters so they become overlay variables on air:

```
donation_donor, donation_amount, donation_message, donation_platform, donation_level
```

No new overlay mechanism — reuse `overlays.alert` / `applyAlert`.

### 6.6 Config (`shared/config.ts` + `server/store.ts`)

```ts
// server/pages/donations/shared/config.ts
export interface DonationsConfig {
	enabled: boolean;
	plugins: {
		kofi: { enabled: boolean; verificationToken: string };
		stripe: { enabled: boolean; webhookSecret: string };
		comgate: { enabled: boolean; merchantId: string; secret: string };
		streamelements: { enabled: boolean; jwt: string; channelId: string };
	};
	bigDonationThreshold: number; // haléře; default 50_000
	currency: string; // display currency; default "CZK"
}

export const SECRET_PATHS = [
	"plugins.kofi.verificationToken",
	"plugins.stripe.webhookSecret",
	"plugins.comgate.secret",
	"plugins.streamelements.jwt",
] as const;

export const configDefaults: DonationsConfig = {
	enabled: true,
	plugins: {
		kofi: { enabled: false, verificationToken: "" },
		stripe: { enabled: false, webhookSecret: "" },
		comgate: { enabled: false, merchantId: "", secret: "" },
		streamelements: { enabled: false, jwt: "", channelId: "" },
	},
	bigDonationThreshold: 50_000,
	currency: "CZK",
};
```

`GET /donations/config` returns the config with each `SECRET_PATHS` value replaced by `{ configured: boolean }`. `POST /donations/config` accepts partial updates; a secret field is only overwritten when a non-empty string is supplied (so the UI can submit the form without re-typing secrets).

---

## 7. Plugins

Each plugin is a small module exporting either `handleWebhook(request)` or `start(dispatch)` / `stop()`:

```ts
export interface DonationPlugin {
	key: "kofi" | "stripe" | "comgate" | "streamelements";
	handleWebhook?(
		request: Request,
		cfg: DonationsConfig,
	): Promise<DonationEvent | null>;
	start?(
		onEvent: (e: DonationEvent) => void,
		cfg: DonationsConfig,
	): Promise<() => void>;
}
```

### 7.1 Ko-fi

- `await request.formData()`, read `form.get("data")` as a JSON string.
- Verify `verification_token` against `config.plugins.kofi.verificationToken`; return `null` on mismatch.
- Amount: multiply `data.amount` (major units) by **100** to get haléře.
- Map `data.from_name` → `donor_name`, `data.message` → `message`.
- `is_recurring`: Ko‑fi sends `type: "Donation" | "Subscription"`.

### 7.2 Stripe

- `const raw = await request.text()` (raw body — **required** for signature verification; do not parse first).
- `stripe.webhooks.constructEvent(raw, sig, cfg.plugins.stripe.webhookSecret)`.
- Accept `payment_intent.succeeded` only.
- Map `pi.amount` (already minor units), `pi.currency.toUpperCase()`.
- `donor_name` from `pi.charges.data[0].billing_details.name`, fall back to `"Anonymous"`.
- Return `null` when the event signature is invalid, or the event type is not `payment_intent.succeeded`.

### 7.3 ComGate

- `await request.json()`, accept only `status === "PAID"`.
- **Re-verify** via `GET https://payments.comgate.cz/v2.0/status?merchant=<id>&transId=<transId>&secret=<secret>` before trusting the push. Compare `transId` and `price` from the push to the API response.
- Map `price` (already in haléře), `curr` (currency).
- Return `null` on any mismatch.

### 7.4 StreamElements

- No HTTP route — this plugin opens a WebSocket in `start`.
- Connect to `wss://astro.streamelements.com/?token=<jwt>&channel=<channelId>`.
- Subscribe to `channel.tips`.
- Map `msg.data.donation` → `DonationEvent`; multiply `d.amount` (major units) by **100**.
- Return a stop function that closes the socket. `server/init.ts` registers that stop function via `services.onShutdown`.

Do **not** implement Streamlabs in the first iteration — it uses Socket.IO, which Bun does not support natively.

---

## 8. Overlay element (`overlay/schema.ts` + `overlay/element.tsx`)

Contributes the `"donation-alert"` element type through `PageModule.overlayElements`.

### 8.1 Schema half

```ts
// server/pages/donations/overlay/schema.ts
import type { OverlayElementSchema } from "../../../../shared/contracts/overlay_element";
import { read } from "../../../../shared/contracts/overlay_element_helpers"; // helpers used by existing elements

export const schema: OverlayElementSchema = {
	type: "donation-alert",
	label: "Donation alert",
	event: "donation", // binds to GET /overlay/alert/donation
	defaultSize: { width: 480, height: 160 },
	defaultProps: {
		template: "{{donor}} sent {{amount}}",
		messageTemplate: "{{message}}",
		durationMs: 5_000,
		soundAssetId: null,
	},
	normalizeProps: (raw) => ({
		template: read.str(raw?.template, "{{donor}} sent {{amount}}"),
		messageTemplate: read.str(raw?.messageTemplate, "{{message}}"),
		durationMs: read.num(raw?.durationMs, 5_000, { min: 500, max: 30_000 }),
		soundAssetId: read.str(raw?.soundAssetId, "") || null,
	}),
};
```

### 8.2 Browser half

```tsx
// server/pages/donations/overlay/element.tsx
import type { OverlayElementDef } from "../../../../shared/ui/overlay/element";

export const element: OverlayElementDef = {
	type: "donation-alert",
	draw: (ctx) => {
		const { donor, amount, message, level } = ctx.vars;
		// render template, use level for the "big donation" style
	},
	editForm: (props, onChange) => [
		// text inputs for template and messageTemplate
		// duration number input
		// asset picker for soundAssetId (uses services.ui.assetPicker)
	],
};
```

The element binds the overlay variables written by the dispatcher (§6.5): `donation_donor`, `donation_amount`, `donation_message`, `donation_platform`, `donation_level`. This is what makes templates react to thresholds without any extra machinery.

**Browser bundling.** `scripts/gen_pages.ts` must include `overlay/element.tsx` in the browser bundle when it exists — the same static import trick it already uses for `frontend/page.tsx` and `frontend/menu.ts`.

---

## 9. Client page (`/donations`)

A single Mithril page that replaces the "optional dashboard widget" from the original brief. It is the primary UI surface for this slice.

```tsx
// server/pages/donations/frontend/page.tsx
export const DonationsPage = {
	oninit: () => store.load(), // GET /donations/config + /recent + /status
	view: () =>
		m(".donations-page", [
			m("h1", "Donations"),
			m(StatusBar, { status: store.status }), // lastDonationAt, totalCount, per-plugin enabled
			m(PluginSection, { config: store.config, onChange: store.patchConfig }),
			m(RecentList, { items: store.recent }), // latest 50
			m(ReplayForm, { onReplay: store.replay }),
		]),
};
```

`client/store.ts` handles three concerns: config GET/POST, recent list GET, and replay POST. All fetches go to `/donations/*` under the same auth session.

The page subscribes to the dashboard WS on the `dashboards` topic and updates its recent list live when a `donations.alert` frame arrives — this reuses the same frame the dashboard widgets already consume.

---

## 10. Testing

Page-local tests under `server/pages/donations/test/` (not root `test/`) — but the boundary test `test/pages_boundaries.test.ts` is updated to include donations in its scan automatically (no edit needed).
1. **Ko-fi normalization** — POST a form-encoded fixture, assert `amount_minor === 15000` for `"150.00"`, correct `donor_name`, and rejection on wrong `verificationToken`.
2. **Stripe signature** — sign a raw body with a test secret; assert invalid signature returns `null` and valid one produces the right event.
3. **ComGate re-verification** — mock the `/2.0/status` fetch (Bun's `mock` on `globalThis.fetch`); assert `status !== "PAID"` is rejected, and a mismatched `transId` between push and status API is rejected.
4. **Idempotency** — dispatch the same `DonationEvent` twice; assert the SQLite table contains one row and `services.dashboard.emit` is called once (via a spy).
5. **Alert translator** — assert `big-donation` above threshold, `ttsText` ASCII-only (`/[^\x00-\x7F]/` must not match), `durationMs` differs for big vs small, `sound` picks the right key.
6. **Overlay contribution** — assert `getOverlayElements()` includes `{ type: "donation-alert" }` when the donations page is loaded.
7. **Boundary** — `test/pages_boundaries.test.ts` must pass (no imports from other pages; `shared/` and `server/` do not cross).
8. **Page proof** — the standalone "empty `recordings/` slice" proof from the refactor handoff is unchanged; donations itself is the real proof that a page can contribute routes, UI, overlay elements and bus events without touching core.

Run `bun test` (which runs `pretest`, which runs `bun run gen:pages`). Then run the full smoke test in §12.

---

## 11. Documentation

- `server/pages/donations/README.md` — module overview, endpoints, plugin setup, overlay element usage, config schema.
- `docs/overlays.md` — add a "Donation alert element" subsection under "Elements". Update any path references from `server/modules/donations/` → `server/pages/donations/`.
- Main `README.md` page table — add a row for `donations` (`page`, `server routes`, `overlay element`, dashboard bus events).
- Refactor PR description — note that Donations is the first post-refactor page and list the three additive core changes (§4) that it required, with pointers to the PRs that landed them.

---

## 12. Constraints & gotchas

| Constraint                      | Detail                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No second Bun server**        | Routes go through `server.routes` (Elysia plugin). `Bun.serve` is already running in the shell.                                                                                              |
| **Raw body for Stripe**         | `await request.text()` before any parse. Do not let Elysia parse this route's body.                                                                                                          |
| **ComGate re-verification**     | Never trust the push; call `/2.0/status` and compare `transId`. Reject on any mismatch.                                                                                                      |
| **StreamElements amount units** | `amount` is in **major units**; multiply by 100. Same for Ko-fi.                                                                                                                             |
| **Ko-fi form-encoded**          | `req.formData()` → `form.get("data")` is a JSON string, not an object.                                                                                                                       |
| **Idempotency**                 | `${platform}:${event.id}` is the primary key. `INSERT OR IGNORE` prevents duplicates on webhook retries.                                                                                     |
| **Secrets masking**             | `GET /donations/config` and `GET /donations/status` must replace every `SECRET_PATHS` value with `{ configured: boolean }`.                                                                  |
| **Auth boundary**               | `/webhook/donations/*` bypasses session middleware; `/donations/*` does not. Use the core's existing unauthenticated-route pattern (see §9 Q1).                                              |
| **SQLite WAL**                  | `PRAGMA journal_mode = WAL` on the donations DB. Register `closeDb()` via `services.onShutdown`.                                                                                             |
| **Cross-page imports**          | Forbidden by `test/pages_boundaries.test.ts`. Overlay lookups use `services.db` queries, not `import` from `../overlays/`.                                                                   |
| **`gen:pages`**                 | Must run before `bun test` and `bun run dev`. It's already wired into `predev`/`pretest` by the refactor; verify it also imports `overlay/schema.ts` and `overlay/element.tsx` when present. |
| **Frozen names**                | HTTP routes, bus topic `donations.alert`, overlay element type `"donation-alert"`, and config field names are frozen once shipped.                                                           |
| **No legacy module**            | Do **not** create `server/modules/donations/`. The module system is untouched by this work.                                                                                                  |

---

## 13. Deliverables checklist

- [ ] `server/pages/donations/index.ts` — `PageModule` export.
- [ ] `server/pages/donations/backend/routes.ts` — Elysia plugin.
- [ ] `server/pages/donations/backend/init.ts` — plugin lifecycle + WS start/stop.
- [ ] `server/pages/donations/backend/store.ts` — `bun:sqlite` schema + config store + `closeDb`.
- [ ] `server/pages/donations/backend/dispatcher.ts` — persist → translate → publish → overlay trigger.
- [ ] `server/pages/donations/backend/alert_translator.ts`.
- [ ] `server/pages/donations/backend/plugins/{kofi,stripe,comgate,streamelements}.ts`.
- [ ] `server/pages/donations/frontend/{page.tsx,menu.ts,store.ts,components/*}`.
- [ ] `server/pages/donations/overlay/{schema.ts,element.tsx}`.
- [ ] `server/pages/donations/shared/{types.ts,config.ts}`.
- [ ] `server/pages/donations/i18n/{en,cs}.json`.
- [ ] `server/pages/donations/test/donations.test.ts` + fixtures.
- [ ] `server/pages/donations/README.md`.
- [ ] **Additive core changes** (§4): `PageModule.overlayElements`, `PageServices.onShutdown` (or `init` disposer), optional `PageServices.dashboard.emit`; extend `server/core/registry.ts` (`getOverlayElements`) and `scripts/gen_pages.ts` (overlay imports).
- [ ] `bun run gen:pages && bun test` — all green, including `test/pages_boundaries.test.ts`.
- [ ] Manual smoke (§14).

---

## 14. Manual verification

1. `bun run dev` → `Donations` appears in the menu between Overlays and Assets.
2. Open `/donations`; the config form renders; toggling a plugin persists after reload.
3. `curl -X POST http://localhost:PORT/webhook/donations/kofi -d 'data=...'` with a fixture → `{ ok: true }`, dashboard WS receives `donations.alert`, the page's recent list updates live.
4. Open an OBS overlay editor; the `donation-alert` element appears in the palette; drag it onto a canvas.
5. Open the overlay runtime page for that overlay; replay the Ko-fi payload → the overlay shows the alert with donor name, amount, and message.
6. Post the same payload again → `{ ok: true, deduped: true }`, no second alert, one row in `donations.db`.
7. Trigger a donation above `bigDonationThreshold` → `level: "big-donation"`, `durationMs: 10000`, `sound: "donation-big"`.
8. Configure StreamElements with a test JWT → `status` shows `streamelements: enabled`; killing the server logs a clean WS close (no unhandled promise rejection).

---

## 15. Open questions for the implementer

These are the questions that remain **after** the refactor. Resolve each before writing the HTTP layer.
1. **Unauthenticated route pattern.** The `/webhook/donations/*` prefix must bypass the session middleware. Locate the core's existing pattern for public routes (search `server/` for `withoutAuth`, `skipAuth`, `/overlay/`, `/ws/`, or the middleware config in `server/core/app.ts`). If the core has no public-route escape hatch, add one to `server/core/app.ts` — but this would be a fourth small additive change, so try to reuse an existing pattern first.

2. **DB placement.** The handoff recommends a page-local `donations.db` in the same directory as the control server DB (WAL enabled, closed via `services.onShutdown`). Confirm this works with `server/core/services.ts` — does `services.config` expose the control-server DB directory? If not, add a `services.paths.dbDir` (or similar) as a minimal addition. Alternative: use `services.db` (shared DB) with dedicated tables. The separate file is preferred for audit volume.

3. **Overlay discovery.** Recommendation: publish the alert on the `overlay-runtime` WS topic and let each runtime page filter — this keeps the dispatcher free of cross-slice DB queries. Verify that the overlay runtime WS actually receives broadcast frames today (see `server/pages/overlays/` after the refactor). If it only accepts targeted `overlays.alert` calls, fall back to a `services.db` query for overlays containing `donation-alert`, and keep the query in `dispatcher.ts` (a plain SQL string, no imports from `../overlays/`).

4. **`init` cleanup.** Does the post-refactor `PageInit` already support returning a disposer or receive `services.onShutdown`? If neither, add **`services.onShutdown`** (§4.2) before wiring the StreamElements WS.

5. **`gen:pages` overlay imports.** Extend the manifest generator to import `overlay/schema.ts` and `overlay/element.tsx` when the file exists. Confirm the generated `PageModule` shape (`server` stubbed) still type-checks with the new `overlayElements` field.

Resolve these five before writing `backend/routes.ts`. All plugin logic (§7), the alert translator (§6.4) and the overlay element contract (§8) can be implemented independently of the answers, so start there in parallel.
