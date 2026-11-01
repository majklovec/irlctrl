# Overlay editor (OBS)

The control server ships a visual overlay editor. Scenes you compose there are
served as transparent runtime pages that OBS loads with a **Browser Source**.

- Overlay list: `/overlays/`, scene editor: `/overlays/edit/<scene id>/` (logged-in users only)
- Runtime: `/overlay/<scene-slug>?token=<token>` (no session, token-gated)
- Schema, limits and normalization: [`shared/overlay.ts`](../shared/overlay.ts)
- Element plugin contract: [`shared/contracts/overlay_element.ts`](../shared/contracts/overlay_element.ts)
  (schema half) and [`shared/ui/overlay/element.ts`](../shared/ui/overlay/element.ts)
  (browser half)
- Built-in elements: [`server/modules/overlay_elements/`](../server/modules/overlay_elements/);
  the chat element lives in the chat module
  ([`server/modules/chat/overlay_elements.tsx`](../server/modules/chat/overlay_elements.tsx))
- Server: [`server/backend/overlays/`](../server/backend/overlays/)

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
| `bindings`    | attribute path → variable map (`props.*`, `transform.*`, `visible`), see [Binding](#binding) |

### Element types

| Type         | Props                                                                                       | Selector handles |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------- |
| `text`       | `text`, `fontSize` (1–2000, 48), `fontFamily`, `color`, `fontWeight` (400/600/700/900), `lineHeight` (0.1–10), `textAlign` (left/center/right) | box |
| `image`      | `assetId` — references a project asset; a missing asset renders an empty placeholder box    | box |
| `rectangle`  | `fill`, `stroke` (both `#rrggbb`), `strokeWidth` (0–500), `radius` (corner radius, 0 = square) | box |
| `ellipse`    | `fill`, `stroke`, `strokeWidth`                                                             | box |
| `line`       | `stroke`, `strokeWidth` (1–500), `flip` (box diagonal: false = TL→BR, true = TR→BL)         | two endpoint handles |
| `group`      | none — a pure container; children are the elements whose `parentId` points at it            | none |
| `iframe`     | `url` — any absolute URL; `""` renders a dashed placeholder box                             | box |
| `chat`       | `url` — set by the module picker only, points at a chat widget's live page (see [URL binding](#url-binding)) | box |

Every element attribute — props, `transform` fields and `visible` — can be
bound to a variable (see [Binding](#binding) below).

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
- **Modify URL** — each row of the *Variables* footer shows a copy icon next
  to the name; it copies the variable's token URL
  (`<origin>/overlay/variables/<id>?token=…`). Appending `&value=…` and
  fetching the URL (browser, curl, script) sets the value — typed per
  variable: `number` accepts finite numbers, `boolean` accepts `true`/`false`,
  `color` accepts `#rrggbb`, `string` accepts anything. The fetch returns
  `{"ok":true,"variable":{…}}` and fans out exactly like an in-editor edit
  (editor feed + runtime feed, so a live scene re-renders). A missing token
  or variable 404s; a bad value 400s. The token is a write credential for
  that variable — treat the URL like a password.

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
"Bind to variable"). Checking it binds the attribute to the first project
variable immediately and swaps the field's control for a select over the
project variables; unchecking removes the binding. The toggle stays disabled
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
removes every binding that references it (server-side, before the project is
persisted).

## Events

Every mutation goes over REST and is fanned out to two WebSocket topics
(see `feed`/`runtime` in [`server/backend/overlays/overlay_store.ts`](../server/backend/overlays/overlay_store.ts)):

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
| `/overlay/variables/<id>?token=`           | project token              | one variable; without `&value=` it 400s (read via the editor), with `&value=…` it revalues it and returns the new variable |
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
   (may parent other elements) and `assetProps` (props holding a project
   asset id, validated against the project's assets). This file must stay
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
   stored projects, and add a migration step to `MIGRATIONS` in
   `shared/overlay.ts`.
