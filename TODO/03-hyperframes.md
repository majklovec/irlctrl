# HyperFrames Element

## 1. Context

**Repository:** `https://github.com/majklovec/irlctrl`
**Target directory:** `server/modules/overlay_elements/`
**Your task:** Add a new overlay element type called `hyperframes` that renders [HyperFrames](https://github.com/heygen-com/hyperframes) compositions/animations/videos inside an overlay.

**What HyperFrames is:** An HTML-based animation/video composition format by HeyGen. Each composition is a self-contained HTML file (or URL) that can be played back using the official `@hyperframes/player` web component (`<hyperframes-player>`). The player auto-detects the composition's native size and scales it to its container. It exposes attributes like `src`, `srcdoc`, `controls`, `autoplay`, `loop`, `muted`, and `volume`.

**What the user expects:** A first-class overlay element in irlctrl, on par with the existing `image`, `video`, and `iframe` elements — configurable via the overlay inspector, pliable in the overlay layout, and rendered via `<hyperframes-player>`.

---

## 2. Before you write any code

The proposal above is a **reference implementation**, not gospel. The `overlay_elements` module in `irlctrl` follows a strict contract (`OverlayElementDef`, `ElementContext`, `ElementProps`, `bindField`, `strProp`/`numProp`, `OverlayElementSchema`, `normalizeProps`). Your first job is to **read the module and align with the current contract**, because helper names and type shapes may have changed since this proposal was drafted.

Mandatory reading (in this order):
1. `server/modules/overlay_elements/overlay_elements.tsx` — element registry.
2. `server/modules/overlay_elements/overlay_schema.ts` — schemas + `normalizeProps` helpers.
3. `server/modules/overlay_elements/elements/iframe.tsx` — **closest analog**, mirror its structure exactly.
4. `server/modules/overlay_elements/elements/video.tsx` — pattern for media playback props (`autoplay`, `loop`, `muted`, `volume`).
5. `server/modules/overlay_elements/i18n/en.json` — i18n key naming convention.
6. `@ui/overlay/element` (find it via `grep -r "OverlayElementDef" server/`) — the actual type definitions.
7. `@ui/overlay/fields` — `bindField` signature.
8. The icon set (`@ui/components/icons`) — confirm which icon names exist. **Do not assume `film` exists** — pick a real one, e.g. reuse whatever `video`/`iframe` uses if nothing better is available.

If the reference implementation in section 3 uses helpers that don't exist (`boolProp`, `strProp`, etc.), do not invent shims silently — check the real module for equivalents first.

---

## 3. Deliverables

Four files changed/created. Do not touch anything else unless a typecheck forces you to.

### 3.1 `server/modules/overlay_elements/overlay_schema.ts` — MODIFY

Append (matching the existing style in that file, which may differ from the sample below):
- `HyperframesProps` interface
- `DEFAULT_HYPERFRAMES_PROPS` constant
- `hyperframesSchema` definition with a `normalizeProps` function

**Props to support:**

| Prop              | Type    | Default | Constraint        |
| ----------------- | ------- | ------- | ----------------- |
| `compositionUrl`  | string  | `""`    | max 10 000 chars  |
| `compositionHtml` | string  | `""`    | max 100 000 chars |
| `controls`        | boolean | `true`  | —                 |
| `autoplay`        | boolean | `false` | —                 |
| `loop`            | boolean | `false` | —                 |
| `muted`           | boolean | `false` | —                 |
| `volume`          | number  | `1`     | 0–1, clamped      |

`compositionHtml` takes precedence over `compositionUrl` when non-empty.

### 3.2 `server/modules/overlay_elements/elements/hyperframes.tsx` — CREATE

New element file exporting `hyperframesElement: OverlayElementDef`. Required capabilities:
- **`draw(element, ctx)`**
  - Load the HyperFrames player script once (idempotent — check `customElements.get("hyperframes-player")` first).
  - If both `compositionUrl` and `compositionHtml` are empty: return a dashed placeholder box with an i18n message (`overlay.missing_hyperframes_composition`).
  - Otherwise, render `<hyperframes-player>` with attrs from the props. Use `srcdoc` when `compositionHtml` is set, `src` when only the URL is set.
  - Style the element to fill its box (`width: 100%`, `height: 100%`) — the player handles scaling internally.
- **`editForm({ element, mutate, variables })`**
  - Text input for `compositionUrl`
  - Textarea (4 rows) for `compositionHtml`
  - Checkboxes for `controls`, `autoplay`, `loop`, `muted`
  - Number input (0–1, step 0.01) for `volume`
- **`validate(element)`**
  - Return error if both `compositionUrl` and `compositionHtml` are empty.
- **`defaultProps`, `propKeys`, `defaultSize`, `handles: "box"`, `labelKey`, `icon`, `order`** — mirror `iframe.tsx` (default size 640×360, order 85, icon: pick a real existing icon).

**Script URL:** use the pinned CDN package (`https://cdn.jsdelivr.net/npm/@hyperframes/player@latest/dist/hyperframes-player.global.js`) or, if the project vendors third-party assets, add it there instead. **Check the repo's CSP / static asset conventions first** — an external script from a CDN may be blocked. If so, vendor the `.js` under the project's public assets and load it from there.

### 3.3 `server/modules/overlay_elements/overlay_elements.tsx` — MODIFY

- Import `hyperframesElement`.
- Add it to the exported registry array (next to `videoElement` / `iframeElement`, order ~85).

### 3.4 `server/modules/overlay_elements/i18n/en.json` — MODIFY

Add:

```json
"overlay.add_hyperframes": "HyperFrames",
"overlay.hyperframes_url": "Composition URL",
"overlay.hyperframes_html": "Composition HTML",
"overlay.hyperframes_controls": "Show controls",
"overlay.hyperframes_autoplay": "Autoplay",
"overlay.hyperframes_loop": "Loop",
"overlay.hyperframes_muted": "Muted",
"overlay.hyperframes_volume": "Volume",
"overlay.missing_hyperframes_composition": "No composition selected"
```

If the repo has an i18n parity check (search for `i18n` scripts in `package.json` or `server/modules/overlay_elements/i18n/`), also add the keys to the other locale files — even if only English text, to avoid failing the parity check.

---

## 4. Reference implementation

The full draft of `elements/hyperframes.tsx` and `hyperframesSchema` is in the previous message of this conversation. **Use it as a scaffold, not as finished code.** Before copying:
- Confirm `strProp` / `numProp` signatures match what the reference code assumes (4th arg = fallback?).
- Confirm `bindField` signature — the field path `"props.compositionUrl"` and the `sp` object `{ mutate, variables }` are guesswork from the reference; check `@ui/overlay/fields` for the real shape.
- Confirm `OverlayElementDef` field names (`labelKey`, `defaultSize`, `handles`, `order`, `propKeys`) — they may have drifted.
- Replace any invented helpers (`boolProp`) with the module's real helper if one exists.
- Replace `Icon name="film"` with a real icon name from `@ui/components/icons`.

---

## 5. Acceptance criteria

A PR is done when **all** of these hold:
1. `pnpm -r exec tsc --noEmit` (or the repo's typecheck command) passes.
2. `pnpm -r build` (or equivalent) passes.
3. In a running dev instance:
   - A new "HyperFrames" entry appears in the overlay element picker with a working icon and label.
   - Dropping it into an overlay shows the dashed placeholder (since no composition is configured).
   - Setting a valid `compositionUrl` (any public HyperFrames sample) renders and plays the composition in the overlay.
   - Pasting raw composition HTML into `compositionHtml` renders and plays it (overriding the URL).
   - Toggling `controls`, `autoplay`, `loop`, `muted`, and adjusting `volume` visibly affects playback.
   - `validate` shows an error when both fields are empty.
   - The element scales correctly when the overlay is resized / the element box is resized.
4. No regressions: existing `image`, `video`, `iframe`, and text elements still render.
5. No console errors on element insertion or removal.

---

## 6. Risks & things to double-check

- **CSP / script loading.** Adding an external CDN script may be blocked by the app's Content-Security-Policy. If blocked, vendor the player JS and reference it from the project's own assets. Do **not** inline the whole player bundle into the element file.
- **Web component registration timing.** `customElements.whenDefined` may be needed if `draw` runs before the script finishes loading. Prefer: register the script once in module scope, and rely on the browser's custom-element upgrade to render `<hyperframes-player>` after load (an unstyled unknown element is fine until then).
- **`srcdoc` size limits.** A 100 000-char cap on `compositionHtml` is generous; confirm the overlay persistence layer accepts payloads that large (check `overlay_schema.ts` and any DB column sizes).
- **Sandboxing.** `<hyperframes-player>` will execute arbitrary HTML from the composition. Since overlay content is user-authored and this is a self-hosted tool, this is likely acceptable — but note it in the PR description so a maintainer can decide whether to add a `sandbox` attribute.
- **Autoplay policies.** Browsers block unmuted autoplay; the player may log warnings. Consider defaulting `muted: true` when `autoplay: true` in the element's default props, or leave as-is and rely on the player's own fallback. Document whichever you choose.
- **Icon.** Do not ship with a non-existent icon name — that's an easy way to fail a lint rule or crash the icon component.
- **i18n parity.** Missing keys in other locale files will fail CI in many setups.

---

## 7. Out of scope

- Building a HyperFrames composition editor.
- Uploading compositions to a server / hosted storage.
- Timeline scrubbing / playback sync across multiple elements.
- Changes to the overlay renderer or the overlay page template.

If any of these become necessary to satisfy the acceptance criteria, stop and flag it in the PR rather than expanding scope silently.

---

## 8. Suggested PR structure

- One commit per logical change:
  1. `feat(overlay): add hyperframes schema`
  2. `feat(overlay): add hyperframes element`
  3. `feat(overlay): register hyperframes element`
  4. `i18n(overlay): add hyperframes strings`
- PR description: what was added, the risks called out in section 6, and how a reviewer can manually test each acceptance criterion.
