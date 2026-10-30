# Overlay editor (OBS)

The control server ships a visual overlay editor. Scenes you compose there are
served as transparent runtime pages that OBS loads with a **Browser Source**.

- Editor: `/overlays/` (logged-in users only)
- Runtime: `/overlay/<scene-slug>?token=<token>` (no session, token-gated)

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

## Tokens

- One runtime token per control server (one per user account's project).
- The token is the only credential the runtime URL needs. Requests without a
  valid token render an **empty page** (no data, no error text).
- **Rotate** in the editor footer: every previously shared URL stops
  immediately; copy the new URL into the OBS Browser Source.
- Treat the token like a password: it grants read access to your scenes and
  variable values.

## Adding a new element type

Element types are a union in [`shared/overlay.ts`](../shared/overlay.ts):

1. Add the type to `ElementType` and a `props` shape to the `OverlayElement`
   union; validate it in `normalizeProps` (unknown props are preserved on
   round-trip — keep that true for forward compatibility).
2. Render it in [`frontend/ts/overlay-render.tsx`](../frontend/ts/overlay-render.tsx)
   (used by both the editor canvas and the runtime page).
3. Add its inspector block in [`frontend/ts/overlays.tsx`](../frontend/ts/overlays.tsx)
   (`inspectorProps`) plus any `overlay.*` i18n keys in `i18n/en.json`
   (mirror them into the other locale catalogs).
4. Bump `PROJECT_SCHEMA_VERSION` **only** if the change breaks existing
   stored projects, and add a `migrate_v*` step in `shared/overlay.ts`.
