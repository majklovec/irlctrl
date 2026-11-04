# Overlay editor (OBS)

The control server ships a visual overlay editor. Overlays you compose there are
served as transparent runtime pages that OBS loads with a **Browser Source**.

A user can have **multiple independent overlays** (stored in the `overlays`
table). Each overlay is fully self-contained — its own canvas, variables and
elements — and has its **own runtime token**, so one account can run several
OBS scenes side by side. Media (images, videos, alert sounds) is not stored
in the overlay: elements reference files in the user's asset library, which
the server keeps on disk (the `--storage` directory) and serves to the
runtime page through its token-scoped file endpoint.

- Overlay list: `/overlays/`, overlay editor: `/overlays/edit/<overlay id>/` (logged-in users only)
- Runtime: `/overlay/<overlay id>?token=<token>` (no session, token-gated)
- Schema, limits and normalization: [`shared/overlay.ts`](../shared/overlay.ts)
- Element plugin contract: [`shared/contracts/overlay_element.ts`](../shared/contracts/overlay_element.ts)
  (schema half) and [`shared/ui/overlay/element.ts`](../shared/ui/overlay/element.ts)
  (browser half)
- Built-in elements: [`server/modules/overlay_elements/`](../server/modules/overlay_elements/);
  the chat element lives in the chat module
  ([`server/modules/chat/overlay_elements.tsx`](../server/modules/chat/overlay_elements.tsx))
- Server: [`server/backend/overlays/`](../server/backend/overlays/)

## OBS setup

1. Open **Overlays** in the control server, select (or create) an overlay.
2. In the footer's *OBS* panel, copy the overlay's **runtime URL**
   (includes the token) and note the canvas size (default 1920×1080).
3. In OBS, add a **Browser Source**:
   - *Load a local file, network stream, or URL* → paste the runtime URL.
   - Width/height → the overlay's canvas size.
   - *Refresh browser when scene becomes active* → off (state is restored
     automatically from the saved overlay).
4. Recommended: enable *"Shutdown source when not visible"* for scenes that do
   not need to keep running off-screen.

The runtime page holds its last known state and reconnects with backoff when the
control server restarts; OBS should not need to re-add the source.

## Elements

Each element is one row of an overlay (`Overlay.elements`); the array order is
the z-order, index 0 renders at the back. Every element shares the same base
shape (see `ElementBase` in [`shared/overlay.ts`](../shared/overlay.ts)):

| Field         | Meaning                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `id`, `name`  | identity and canvas label                                                            |
| `type`        | one of the eight types below                                                         |
| `transform`   | `x`, `y`, `width`, `height` (px), `rotation` (deg, −720…720), `opacity` (0…1)        |
| `visible`     | `false` = hidden (still present in the scene)                                        |
| `locked`      | `true` = not editable in the inspector                                               |
| `parentId`    | id of a `group` element, `null` for root elements                                    |
| `props`       | type-specific content (see below); unknown keys are preserved on round-trip          |
| `bindings`    | attribute path → variable map (`props.*`, `transform.*`, `visible`), see [Binding](#binding) |

### Element types

| Type         | Props                                                                                       | Selector handles |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------- |
| `text`       | `text`, `fontSize` (1–2000, 48), `fontFamily`, `color`, `fontWeight` (400/600/700/900), `lineHeight` (0.1–10), `textAlign` (left/center/right) | box |
| `image`      | `libraryAssetId` — a file id from the asset library (the inspector's picker); a missing file renders an empty placeholder box | box |
| `rectangle`  | `fill`, `stroke` (both `#rrggbb`), `strokeWidth` (0–500), `radius` (corner radius, 0 = square) | box |
| `ellipse`    | `fill`, `stroke`, `strokeWidth`                                                             | box |
| `line`       | `stroke`, `strokeWidth` (1–500), `flip` (box diagonal: false = TL→BR, true = TR→BL)         | two endpoint handles |
| `group`      | none — a pure container; children are the elements whose `parentId` points at it            | none |
| `iframe`     | `url` — any absolute URL; `""` renders a dashed placeholder box                             | box |
| `chat`       | `url` — set by the module picker only, points at a chat widget's live page (see [URL binding](#url-binding)); `fontSize` (1–2000, 48), `fontFamily`, `color`, `fontWeight` (100–900), `lineHeight` (0.1–10) style the feed text | box |

Every element attribute — props, `transform` fields and `visible` — can be
bound to a variable (see [Binding](#binding) below).

`iframe` and `chat` share one renderer: the embedded page is display-only in
the editor (`pointer-events: none` so drags/select fall through) and runs
unsandboxed at runtime, so it can execute its own scripts and authenticated
fetches.

### Overlay limits

From `OVERLAY_LIMITS`: ≤ 50 overlays per user; canvas 16…8192 px per axis,
≤ 500 elements per overlay, ≤ 200 variables, coordinates ≤ 100 000.

## Variables

Overlay-scoped named values, edited in the editor's *Variables* footer (each
overlay has its own set).

- **Types**: `string`, `number` (finite), `boolean`, `color` (`#rrggbb`).
- **Names**: unique per overlay, `^[a-zA-Z_][a-zA-Z0-9_]*$`, max 120 chars.
- **Values** live in the overlay row and are mutable at any time via
  `PUT /api/overlays/:id/variables/:vid` — including while an overlay is on
  air; bound elements re-render live in the runtime page.
- **Modify URL** — each row of the *Variables* footer shows a copy icon next
  to the name; it copies the variable's token URL
  (`<origin>/overlay/variables?token=…&<name>=`). Completing the URL with a
  value and fetching it (browser, curl, script) sets the value — typed per
  variable: `number` accepts finite numbers, `boolean` accepts `true`/`false`,
  `color` accepts `#rrggbb`, `string` accepts anything. Several variables can
  be set in one fetch — append `<name2>=<value2>…` — and an empty value
  (`<name>=`) empties the variable to its neutral value (0 / false /
  `#000000` / ""). `POST /overlay/variables?token=…` accepts the same batch
  as a JSON body (`{<name>: value|null}`, typed JSON values, `null`/`""`
  empties). The
  fetch returns `{"ok":true,"variables":[…]}` and fans out exactly like an
  in-editor edit (editor feed + runtime feed, so a live overlay re-renders) —
  the whole batch in one frame. A missing token or variable 404s; a bad value
  400s. The token is a write credential for that overlay's variables — treat
  the URL like a password.

### Binding

A binding maps one element attribute path to a variable and is stored on the
element (only variable references are supported; an expression kind is
reserved for a future schema bump):

```jsonc
"bindings": {
    "props.url": { "kind": "variable", "variableId": "…" },
    "transform.x": { "kind": "variable", "variableId": "…" },
    "visible": { "kind": "variable", "variableId": "…" }
}
```

Every element attribute is bindable, through three path families:

- **`props.<name>`** — the raw element prop. The variable value replaces the
  prop value (no coercion; strings, numbers and booleans pass through).
- **`transform.<field>`** — one of `x`, `y`, `width`, `height`, `rotation`,
  `opacity`. The variable value is coerced to a number and must be finite;
  `opacity` must additionally be in `0…1`, otherwise the binding is ignored
  for that frame.
- **`visible`** — the element is shown while the variable value is truthy
  (non-empty string, non-zero number, or `true`). This is what powers the
  classic "show element when variable X is non-empty" use case; there is no
  separate show/hide binding kind.

In the inspector, every bindable attribute gets a small, label-less checkbox
directly next to its field (its tooltip is the only visible hint, e.g.
"Bind to variable"). Checking it binds the attribute to the first of the
overlay's variables immediately and swaps the field's control for a select over
the overlay's variables; unchecking removes the binding. The toggle stays disabled
while no variables exist, so a bound-but-unresolvable state can never be
created. Transform fields and visibility live in the core inspector; the
element-specific props get their toggles where the element's `editForm`
renders its fields (via `bindField` in
[shared/ui/overlay/fields.tsx](../shared/ui/overlay/fields.tsx)).

Resolution happens once per element at render time in
`resolveElement` ([`shared/ui/overlay/element.ts`](../shared/ui/overlay/element.ts))
— editor canvas and runtime page share the exact same code path, so a bound
element looks identical in both. Unknown paths are ignored, so stale
bindings on element-type changes never break rendering. Deleting a variable
removes every binding that references it (server-side, before the overlay is
persisted).

## Events

Every mutation goes over REST and is fanned out to two WebSocket topics
(see `feed`/`runtime` in [`server/backend/overlays/overlay_store.ts`](../server/backend/overlays/overlay_store.ts)):

1. **Editor feed** — topic `dashboards:<user>` on the shared `WS /dashboards/ws`
   (cookie session). Delivered to every open editor tab, so multiple editors
   stay in sync.
2. **Runtime feed** — topic `overlay-runtime:<overlay id>` on
   `WS /overlay/<overlay id>/ws?token=…` (overlay token, no session).
   Delivered to that one overlay's OBS runtime page (each overlay feeds its
   own topic, so one user's overlays never feed each other).

| Event                 | Payload                    | Fires when                                                        | Editor | Runtime |
| --------------------- | -------------------------- | ------------------------------------------------------------------ | :----: | :-----: |
| `overlays.snapshot`   | `{overlay, version}`       | Runtime WS connects, after the token check (the full overlay; `version` is the server build stamp the page compares to its own bundle to reload after a new deployment) | –    | ✔ |
| `overlays.overlays`   | `{overlays}`               | the user's overlay list changed (create/delete/duplicate) — each item is a summary `{id, name, token, elementCount, updatedAt}` | ✔      | – |
| `overlays.overlay`    | `{overlay}`                | any mutation of one overlay: rename, element add/update/delete, canvas resize, variable create/rename/retype/revalue/delete | ✔      | ✔ |
| `overlays.alert`      | `{name, payload}`          | `GET /overlay/alert/<name>` was called (the trigger event; `payload` carries the trigger's validated `<name>=<value>` pairs) | – | ✔  |
| `overlays.applyAlert` | `{values}`                 | uplink: the runtime page goes on air with an alert and writes its values to the overlay variables (`overlays.overlay` frame is the ack) | – | uplink |
| `overlays.token`      | `{overlayId, token}`       | that overlay's token rotation                                       | ✔      | –  |

Notes:

- Every overlay mutation bumps `overlay.rev` (server-managed monotonic counter).
  The editor and the runtime page drop out-of-order pushes carrying a lower
  `rev` so a late broadcast can never clobber a newer local state.
- Dragging/resizing an element in the editor pushes the in-progress transform
  to the server **live** (a throttled save, at most one per 100 ms with a
  trailing edge; mouseup flushes the final position immediately), so the
  runtime page tracks the gesture in real time instead of jumping when it
  ends.
- The runtime page holds its last known state on disconnect and reconnects
  with exponential backoff (1 s → 30 s); a bad token keeps it blank (the
  server closes the WS with 1008).
- Trigger-based elements (v1: the `Alert` element) fire off **named
  events**: `GET /overlay/alert/<name>?token=…[&<name>=<value>…]` publishes
  an `overlays.alert` frame and the runtime page shows every alert whose
  *Event* prop equals `<name>`. Consecutive triggers on the same element
  **queue FIFO** — a second trigger while the first is on air starts right
  when the first expires (different elements fire independently). Any
  `?<name>=<value>` pairs are validated in the same call (typed like the
  variables endpoint, 404/400 on unknown/bad values) and ride in the
  frame's `payload`; the runtime page writes them to the overlay variables
  **when the alert goes on air** — so a queued alert's values never
  clobber the on-air ones early — and persists them with the
  `overlays.applyAlert` WS uplink (the `overlays.overlay` frame that
  follows is the ack). The written values persist: the runtime page never
  clears them (variation `amount` thresholds read the variable, so
  templates and TTS see the trigger's values while the alert is on air).
  A bare trigger without values (`/overlay/alert/follow?token=…`) is
  valid; `<name>` does not need to be a variable, it just needs to match
  an element's *Event* prop on the runtime page.

## URL binding

| URL                                        | Auth                       | Serves                                     |
| ------------------------------------------ | -------------------------- | ------------------------------------------ |
| `/overlays/`                               | cookie session             | the overlay list; the editor lives at `/overlays/edit/<overlay id>/` |
| `/overlay/<overlay id>`                    | overlay token in `?token=` | the transparent runtime page (OBS Browser Source); a bad token renders a blank page |
| `/overlay/variables?token=&<name>=<value>…`| overlay token              | revalue variables from the querystring (several `<name>=<value>` pairs per fetch; an empty value empties the variable to its neutral value: 0 / false / `#000000` / ""), returns the new variable list |
| `POST /overlay/variables?token=`           | overlay token              | revalue variables from a JSON body `{<name>: value\|null}` (`null`/`""` empties), returns the new variable list |
| `/overlay/alert/<name>?token=…[&<name>=<value>…]` | overlay token      | trigger every alert element whose *Event* prop equals `<name>` (queues FIFO per element); optional `<name>=<value>` pairs ride with the alert and are written to the overlay variables when the alert plays (persist), returns `{"ok":true,"name":…}` |
| `/overlay/<overlay id>/ws?token=`          | overlay token              | the runtime live feed (WebSocket; also the page's `overlays.applyAlert` uplink) |
| `/chat/<dashboardId>/<widgetId>?token=`    | per-widget token           | a chat widget's live page                   |

**Overlay token** — one per overlay, 64 hex chars, the only credential the
runtime needs. It is returned by `GET /api/overlays/:id` (the list GET
returns each overlay's token too) and shown (with copy) in the editor;
**Rotate** (`POST /api/overlays/:id/token/rotate`) invalidates that
overlay's previously shared URL immediately. The token alone addresses the
overlay, so the runtime URLs never carry an overlay id.

**Element URLs** — the `iframe` and `chat` elements carry a `props.url`:

- `iframe.url` is free-form (any absolute URL) and can be **bound to a
  variable** — at render time the variable's string value replaces the URL,
  so one element can point at different pages as the variable changes.
- `chat.url` is not free-form: the inspector's module picker writes the
  widget's absolute overlay URL (`<origin>/chat/<dashboardId>/<widgetId>?token=…`,
  token in the query string precisely because an OBS Browser Source has no
  cookies). Selecting *no module* clears it back to the placeholder.

## Tokens

- One runtime token per overlay (the token alone addresses the overlay).
- The token is the only credential the runtime URL needs. Requests without a
  valid token render an **empty page** (no data, no error text).
- **Rotate** in the editor: that overlay's previously shared URL stops
  immediately; copy the new URL into the OBS Browser Source.
- Treat the token like a password: it grants read access to that overlay and
  its variable values. Other overlays in the same account are unaffected.

## Adding a new element type

Element types are module plugins: the core (schema validator, renderer,
editor, runtime) resolves them through two generated registries and never
names one. Any module — under `client/modules/` or `server/modules/` — can
contribute elements; a new type never touches `shared/overlay.ts`,
`overlays/overlay_render.tsx`, the editor (`overlays/overlay_update.tsx`, `overlays/editor/*`) or the runtime page (`overlays/overlay_view.tsx`).

1. **Schema** — add (or extend) `<module>/overlay_schema.ts`, default-exporting
   an array of `OverlayElementSchema` ([contract](../shared/contracts/overlay_element.ts)):
   `type`, `defaultProps`, `normalizeProps(props, read)` (coerce the known
   props with the `read.num/hex/str/oneOf/bool` helpers; unknown keys are
   preserved by the core for forward compatibility), optional `container`
   (may parent other elements) and `serverAssetProps` (props holding a file
   id of the user's asset library, resolved at render time; the runtime page
   serves them through its token-scoped file endpoint). This file must stay
   environment-free — it runs on the control server too.
2. **Browser half** — add (or extend) `<module>/overlay_elements.tsx`,
   default-exporting an array of `OverlayElementDef`
   ([contract](../shared/ui/overlay/element.ts)): `type` (same id),
   `labelKey` / `icon` / `order` for the editor's add-toolbar, `defaultProps`
   (reuse the schema's), `defaultSize`, `draw`, `editForm`, `validate`,
   `handles`, `propKeys`, and `onEndpointDrag` for `handles: "endpoints"`.
   `draw` receives the **resolved** element (bindings already applied) — read
   `element.props` / `element.transform` directly, never resolve again.
   Binding toggles come for free on every field the `editForm` wraps in
   `bindField` (transform fields and `visible` are toggled in the core
   inspector). A form that needs server data (e.g. the chat element's module
   list) fetches it itself.
3. Put the element's i18n keys in `<module>/i18n/<lang>.json` (every
   language in `shared/languages.ts`). `bun run gen:modules` (also run by
   `predev` / `pretest`) regenerates `generated/overlay_schemas.ts` and
   `generated/overlay_elements.ts`.
4. Bump `OVERLAY_SCHEMA_VERSION` **only** if the change breaks existing
   stored overlays, and add a migration step to `MIGRATIONS` in
   `shared/overlay.ts`.
