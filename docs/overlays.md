# Overlay editor (OBS)

The control server ships a visual overlay editor. Scenes you compose there are
served as transparent runtime pages that OBS loads with a **Browser Source**.

- Editor: `/overlays/` (logged-in users only)
- Runtime: `/overlay/<scene-slug>?token=<token>` (no session, token-gated)
- Schema, limits and normalization: [`shared/overlay.ts`](../shared/overlay.ts)
- Element modules: [`frontend/ts/overlay-elements/`](../frontend/ts/overlay-elements/)
- Server: [`backend/server/overlays.ts`](../backend/server/overlays.ts)

## OBS setup

1. Open **Overlays** in the control server, select (or create) a scene.
2. In the footer's *OBS* panel, copy the scene's **runtime URL**
   (includes the token) and note the canvas size (default 1920×1080).
3. In OBS, add a **Browser Source**:
   - *Load a local file, network stream, or URL* → paste the runtime URL.
   - Width/height → the scene's canvas size.
   - *Refresh browser when scene becomes active* → off (state is restored
     automatically from the saved scene).
4. Recommended: enable *"Shutdown source when not visible"* for scenes that do
   not need to keep running off-screen.

The runtime page holds its last known state and reconnects with backoff when the
control server restarts; OBS should not need to re-add the source.

## Elements

Each element is one row of a scene (`Scene.elements`); the array order is the
z-order, index 0 renders at the back. Every element shares the same base shape
(see `ElementBase` in [`shared/overlay.ts`](../shared/overlay.ts)):

| Field         | Meaning                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `id`, `name`  | identity and canvas label                                                            |
| `type`        | one of the eight types below                                                         |
| `transform`   | `x`, `y`, `width`, `height` (px), `rotation` (deg, −720…720), `opacity` (0…1)        |
| `visible`     | `false` = hidden (still present in the scene)                                        |
| `locked`      | `true` = not editable in the inspector                                               |
| `parentId`    | id of a `group` element, `null` for root elements                                    |
| `props`       | type-specific content (see below); unknown keys are preserved on round-trip          |
| `bindings`    | prop → variable map, see [Variables](#variables)                                     |

### Element types

| Type         | Props                                                                                       | Selector handles |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------- |
| `text`       | `text`*, `fontSize` (1–2000, 48), `fontFamily`, `color`, `fontWeight` (400/600/700/900), `lineHeight` (0.1–10), `textAlign` (left/center/right) | box |
| `image`      | `assetId` — references a project asset; a missing asset renders an empty placeholder box    | box |
| `rectangle`  | `fill`, `stroke` (both `#rrggbb`), `strokeWidth` (0–500), `radius` (corner radius, 0 = square) | box |
| `ellipse`    | `fill`, `stroke`, `strokeWidth`                                                             | box |
| `line`       | `stroke`, `strokeWidth` (1–500), `flip` (box diagonal: false = TL→BR, true = TR→BL)         | two endpoint handles |
| `group`      | none — a pure container; children are the elements whose `parentId` points at it            | none |
| `iframe`     | `url`* — any absolute URL; `""` renders a dashed placeholder box                            | box |
| `chat`       | `url` — set by the module picker only, points at a chat widget's live page (see [URL binding](#url-binding)) | box |

\* `*` = prop can additionally be bound to a variable (below).

`iframe` and `chat` share one renderer: the embedded page is display-only in
the editor (`pointer-events: none` so drags/select fall through) and runs
unsandboxed at runtime, so it can execute its own scripts and authenticated
fetches.

### Project limits

From `OVERLAY_LIMITS`: canvas 16…8192 px per axis, ≤ 50 scenes, ≤ 500 elements
per scene, ≤ 200 variables, ≤ 100 assets, ≤ 25 MB base64 per asset, ≤ 100 MB
total asset data, coordinates ≤ 100 000.

## Variables

Project-scoped named values, edited in the editor's *Variables* footer.

- **Types**: `string`, `number` (finite), `boolean`, `color` (`#rrggbb`).
- **Names**: unique per project, `^[a-zA-Z_][a-zA-Z0-9_]*$`, max 120 chars.
- **Values** live in the project blob and are mutable at any time via
  `PUT /api/overlays/variables/:id` — including while a scene is on air;
  bound elements re-render live in the runtime page.

### Binding

A binding maps one element prop to a variable and is stored on the element
(v1 supports variable references only; an expression kind is reserved for a
future schema bump):

```jsonc
"bindings": { "props.url": { "kind": "variable", "variableId": "…" } }
```

Keys are `props.<propName>`. At render time (editor canvas and runtime page
use the same code path, `resolveElementProps` in
[`overlay-elements/core.ts`](../frontend/ts/overlay-elements/core.ts)) the
variable's current value overwrites the prop. In v1 the bindable props are
`text.text` and `iframe.url`. Deleting a variable removes every binding that
references it (server-side, before the project is persisted).

## Events

Every mutation goes over REST and is fanned out to two WebSocket topics
(see `feed`/`runtime` in [`backend/server/overlays.ts`](../backend/server/overlays.ts)):

1. **Editor feed** — topic `dashboards:<user>` on the shared `WS /dashboards/ws`
   (cookie session). Delivered to every open editor tab, so multiple editors
   stay in sync.
2. **Runtime feed** — topic `overlay-runtime:<user>` on
   `WS /overlay/<scene-slug>/ws?token=…` (project token, no session).
   Delivered to the OBS runtime page(s).

| Event                 | Payload                    | Fires when                                                        | Editor | Runtime |
| --------------------- | -------------------------- | ------------------------------------------------------------------ | :----: | :-----: |
| `overlays.snapshot`   | `{scene, variables, canvas, assets}` | Runtime WS connects, after the token check (full initial state) | –    | ✔ |
| `overlays.scene`      | `{scene}`                  | any scene mutation: rename/slug, add/update/delete elements         | ✔      | ✔ (applied only if it is the loaded scene) |
| `overlays.sceneDeleted` | `{sceneId}`              | a scene is deleted                                                 | ✔      | – |
| `overlays.variables`  | `{variables}`              | a variable is created/renamed/retyped/revalued/deleted             | ✔      | ✔ |
| `overlays.project`    | `{project}`                | canvas resize; asset upload/delete (full project, editor-only)     | ✔      | – |
| `overlays.canvas`     | `{canvas}`                 | canvas resize (runtime gets the slim payload)                      | –      | ✔ |
| `overlays.assets`     | `{assets}`                 | asset upload/delete                                                | –      | ✔  |
| `overlays.trigger`    | `{sceneId,eventName,payload}` | `POST /api/overlays/triggers` (forward-compatibility; the v1 runtime page ignores it) | ✔ | ✔ |
| `overlays.token`      | `{token}`                  | token rotation                                                     | ✔      | –  |

Notes:

- Every scene mutation bumps `scene.rev` (server-managed monotonic counter).
  Editors drop out-of-order pushes carrying a lower `rev` so a late broadcast
  can never clobber a newer local state.
- The runtime page holds its last known state on disconnect and reconnects
  with exponential backoff (1 s → 30 s); a bad token keeps it blank (the
  server closes the WS with 1008).
- Triggers (`POST /api/overlays/triggers`) let external systems (e.g. the
  chat, a device pipeline) push a named event into both feeds; v1 delivers
  without effect, the reaction wiring arrives with a later schema bump.

## URL binding

| URL                                        | Auth                       | Serves                                     |
| ------------------------------------------ | -------------------------- | ------------------------------------------ |
| `/overlays/`                               | cookie session             | the editor page                             |
| `/overlay/<scene-slug>`                    | project token in `?token=` | the transparent runtime page (OBS Browser Source); a bad token renders a blank page |
| `/overlay/<scene-slug>/ws?token=`          | project token              | the runtime live feed (WebSocket)           |
| `/chat/<dashboardId>/<widgetId>?token=`    | per-widget token           | a chat widget's live page                   |

**Project token** — one per user (per overlay project), 64 hex chars, the
only credential the runtime needs. It is returned by `GET /api/overlays` and
shown (with copy) in the editor footer; **Rotate**
(`POST /api/overlays/token/rotate`) invalidates every previously shared URL
immediately.

**Element URLs** — the `iframe` and `chat` elements carry a `props.url`:

- `iframe.url` is free-form (any absolute URL) and can be **bound to a
  variable** — at render time the variable's string value replaces the URL,
  so one element can point at different pages as the variable changes.
- `chat.url` is not free-form: the inspector's module picker writes the
  widget's absolute overlay URL (`<origin>/chat/<dashboardId>/<widgetId>?token=…`,
  token in the query string precisely because an OBS Browser Source has no
  cookies). Selecting *no module* clears it back to the placeholder.

## Tokens

- One runtime token per control server (one per user account's project).
- The token is the only credential the runtime URL needs. Requests without a
  valid token render an **empty page** (no data, no error text).
- **Rotate** in the editor footer: every previously shared URL stops
  immediately; copy the new URL into the OBS Browser Source.
- Treat the token like a password: it grants read access to your scenes and
  variable values.

## Adding a new element type

The core (renderer, editor, runtime) only talks to the element registry, so a
new type never touches `overlay-render.tsx`, `overlays.tsx` or `overlay.tsx`:

1. Add the type to `OverlayElementType` in
   [`shared/overlay.ts`](../shared/overlay.ts) plus a `DEFAULT_*_PROPS` shape,
   a `DEFAULT_*_PROPS` shape and a `normalizeProps` case (the REST routes and
   the registry are the only other places a new type shows up). Unknown
   prop keys are preserved on round-trip — keep that true for forward
   compatibility.
2. Create `frontend/ts/overlay-elements/<type>.tsx` implementing
   `OverlayElementDef` (`defaultProps`, `defaultSize`, `draw`, `editForm`,
   `validate`, `handles`) and register it in
   [`registry.ts`](../frontend/ts/overlay-elements/registry.ts). Compose the
   inspector from the shared fields in
   [`fields.tsx`](../frontend/ts/overlay-elements/fields.tsx) (`bindingRow`
   for variable-bindable props).
3. Add the `overlay.*` i18n keys to `i18n/en.json` (mirror them into the
   other locale catalogs).
4. Bump `OVERLAY_SCHEMA_VERSION` **only** if the change breaks existing
   stored projects, and add a migration step to `MIGRATIONS` in
   `shared/overlay.ts`.
