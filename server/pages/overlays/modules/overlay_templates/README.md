# overlay_templates

The `html_template` overlay element: renders a first-party HTML/CSS
template into the overlay (a `m.trust()` node, no iframe). The browser half
renders the element (`element.tsx`), the environment-free half builds the
document (`templates/render_doc.ts`) and validates the scene props
(`overlay_schema.ts`). Each template is ONE self-contained HTML document —
`assets/overlay_templates/<id>.html` (metadata meta tags +
`<style>` + `<section>` body) — served statically under
`/overlay_templates/*` and read **at runtime** (not precompiled). The
runtime catalog fetches `/overlay_templates/_catalog.json`, which the
control server computes by listing the `*.html` files — there is no
index file to maintain.

## 1. How a document is built

`templates/render_doc.ts` (`renderTemplateDoc`) + `doc.ts`
(`buildTemplateConfig`) are PURE (no DOM, no Mithril, no network) — the
same string must come out of the bun test, the editor and a future server
route. The builder:

1. filters the element's **normalized** props through the template's
   `uses` list (derived by the parser from the document's own
   `data-bind` / `data-asset` / `data-countdown` hooks + `:root` vars —
   nothing is hand-listed) — an edit to a prop the template does not use
   cannot change the document (the caching contract);
2. resolves them to a CSS-variable set (accent/bg/text/font/radius/
   padding, `bgAlpha` folded into `--bg` as the rgba alpha);
3. takes the template's parsed `<section>` body (the parser,
   `templates/template_doc.ts`, fails loudly on any `<script>`); bakes
   the resolved text into `[data-bind]` slots (entity-escaped) and the
   logo `src` into `[data-asset]` slots; then wraps the body in
   `<div class="ov-tpl-<id>" style="--vars…">…</div>`.

The template's `<section>` fills the element's box (100% × 100%, no design
canvas, no scaling). Parameters reach
the DOM only through the baked wrapper: CSS variables, entity-escaped text
into `[data-bind]` slots, `src` on `[data-asset]` slots, and the countdown
node. **User text is only ever entity-escaped — it is never concatenated raw
into a handler and never emitted as a `<script>`.**

## 2. The element and its cache

`element.tsx` resolves the `{token}` display strings of the template's text
slots (`title`/`subtitle` plus any free-form `data-bind` name) via the shared
`templateText` (`shared/ui/overlay/template_tokens.ts`),
fetches the bytes once per template id (a module-scope memo over
`loadTemplateDoc`), and caches the rendered doc wrapper in a module LRU
(capped) keyed by `(templateId, resolved config)`. `draw` returns a childless
host `div` (keyed by template) whose `oncreate`/`onupdate` paint
asynchronously: resolve the bytes, `scopeTemplateCss` the styles into a
single `<style>` per template (refcounted over the live hosts — created on
the first paint, removed when the last host goes, so switching a template
away *strips* its rules rather than piling them into `<head>`), and write
the wrapper into `innerHTML`. A
changed config paints a fresh wrapper (restarted CSS animations); an
unchanged paint key is a no-op, so redraws are cheap. User text reaches the
DOM only entity-escaped through the baked wrapper — it is never concatenated
raw into a handler. The host carries no `transform`/`opacity` (CEF promotes
transformed ancestors to opaque layers in OBS) and `pointer-events: none`.

## 3. The prop vocabulary

Two kinds of param.

**Style / asset / countdown params** are a frozen vocabulary — `TemplateParam`
(`templates/template_meta.ts`), the named fields of `HtmlTemplateProps`
(`overlay_schema.ts`): `vars`, `accentColor`, `bgColor`, `bgAlpha`,
`textColor`, `fontFamily`, `fontSize`, `radius`, `padding`, `logoAssetId`,
`mode` (`static` | `countdown`), `targetIso`. A new one of **these** = schema
field + `normalizeProps` + `VAR_WRITERS`/`VAR_NAMES` in `doc.ts`
+ `TemplateParam` + an `uses` entry in the template that consumes it.

**Text slots are not frozen.** Every `data-bind="<slot>"` the template's body
declares is a text param named `<slot>` — `title`/`subtitle` are just the
conventional ones, a template binds whatever it needs (the ticker binds
`label`). No schema change for a new slot: it rides `props.<slot>` (the
binding system handles `props.<anyField>` generically), carries a
`{token}`-templated string, and resolves through `templateText`.
`isTextSlot` (`template_meta.ts`) is what tells a `data-bind` slot apart from
a frozen param.

**`vars` is the style-knob channel.** A template declares its own knobs in
the `:root` block of its `<style>` (each `--name: value` is a knob with a
fallback); the inspector (`element.tsx` → `varsFields`) reads that block at
runtime (`parseRootVars`, from the same document fetch as the render) and
renders
one field per variable — colour picker for 6-digit hex, colour picker +
alpha slider for colours WITH alpha (`rgba(…)`/`hsla(…)`/`#rrggbbaa` —
the native picker has no alpha channel), number input for
`N`/`Npx`-shaped values, text for everything else. Edits land in
`props.vars` (a sanitized, sorted `--name → value` record; editing a field
back to its `:root` default drops the key), and `buildTemplateConfig`
emits them onto the wrapper's inline style when the template's `uses` has
`"vars"` — overriding the scoped `:root` fallback. The template is the
author of its own knobs: no schema change to add `--corner-glow`.

The named style props (`accentColor`, `bgColor`+`bgAlpha`, `textColor`,
`fontFamily`, `fontSize`, `radius`, `padding`) are the **legacy** carriers of
the same values. `normalizeProps` folds their NON-default values into
`vars` (via `namedStyleVars` from `doc.ts`) for scenes saved before `vars`
existed, so an old scene keeps its look; fresh elements keep lean props and
render the `:root` fallbacks. An explicit `vars` record always wins over
the fold.

## 4. Authoring a template

A template is ONE self-contained HTML document
(`assets/overlay_templates/<id>.html`, snake_case file id), served
+ read at runtime — editable on disk with no rebuild. Structure:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="name" content="overlay.tpl.<id>" />
    <style>
      :root { --accent: #6c5ce7; /* …the template's knobs… */ }
      section { position: absolute; inset: 0; width: 100%; height: 100%; }
      /* …the rest of the styles… */
    </style>
  </head>
  <body>
    <section>
      <!-- the body: markup + data-bind / data-asset / data-countdown hooks -->
    </section>
  </body>
</html>
```

- The **id** is the filename (minus `.html`) — dropping the file is the
  whole act of adding a template (the server's `_catalog.json` route
  discovers it, and the schema validates ids as slugs, not against a
  frozen list). The test
  `the auto-discovered catalog is the on-disk template files` pins the set.
- **`name`** — the i18n key of the human name
  (`overlay.tpl.<id>`; add it to all module languages).
- **`uses`** — not written in the document: the parser derives it from
  what the document contains, in fixed order — every `data-bind="<slot>"`
  name (a text param, in document order), then `vars` when `:root` declares
  any variable, `logoAssetId` for a `data-asset="logo"` element,
  `mode, targetIso` for a `data-countdown` element. `buildTemplateConfig`
  only reads a prop when it is derived here, and the doc cache is keyed
  on exactly the derived subset — an edit to a prop the template does not
  use cannot change the document. The text-slot entries are free-form names
  (the `data-bind` slots); the rest are the frozen vocabulary
  (`templates/template_meta.ts`).
- The **`<style>`** holds the template's styles. `:root` declares the
  template's KNOBS: every `--name: value` entry there becomes an editable
  inspector field (label = the name without `--`, separators as spaces,
  first letter capitalised — `--corner-glow` → `Corner glow`) for elements
  using this
  template, and is the fallback the render uses until the element
  overrides it — so `:root` must declare a fallback for every knob AND
  keep the design reviewable in a plain browser tab (open the file
  directly; it renders standing alone). No `url()`, no `@import`. Colour
  literals are allowed only as custom-property values (repo token rule).
  (The template must additionally declare `"vars"` in `uses` for its
  `:root` knobs to be editable/emitted.)
- The **`<section>`** is the body: exactly one, filling the element's box.
  No external files, no `<link>`, no `fetch`, no fonts, no `<script>` of
  its own (the parser fails loudly on a `<script>`) — only markup +
  `data-bind` / `data-asset` / `data-countdown` hooks.
- **`thumb.svg`** *(optional, P2+)* — a small static preview for the
  template picker.

The document is fetched by `catalog.ts` (`loadTemplateDoc`) at runtime from
`/overlay_templates/<id>.html` and parsed by
`templates/template_doc.ts`; nothing is imported as build-time text. Add the
`overlay.tpl.<id>` i18n key to all module languages.

## 5. The hooks

| Hook | Where | Meaning |
|---|---|---|
| `name` | `<head>` meta tag | the template's i18n name (the only meta tag written by hand) |
| `data-bind="<slot>"` | elements in the `<section>` body | a text param named `<slot>`, baked in entity-escaped (tokens pre-resolved); `title`/`subtitle` are just the conventional slots, any name works |
| `data-asset="logo"` | an `<img>` | `src` set from `logoAssetId` → the page's asset URL |
| `data-countdown` | one element | H:MM:SS ticking toward `targetIso` (`mode: "countdown"`) |
| CSS vars | the `<style>`'s `:root` | every `--name: value` knob of the template (`--accent`, `--bg`, …), overridden per element through `props.vars` |

## 6. The caching contract

`buildTemplateConfig` emits an entry **only** for a `uses` member, in a
fixed order (insertion order is the cache-key order). Therefore: two
inputs differing only in unused props produce byte-identical documents;
the bootstrap + cfg block are the dynamic half of the doc; everything
else is part of the template bytes. `test/overlay_templates.test.ts`
pins all of this.

## 7. Limits / known corners

- No per-frame scripts, no `sandbox`, no network — by contract (the
  content is first-party and param-driven, not a web page).
- `hex` readers carry no alpha — `bgAlpha` folds into `--bg` as the rgba
  alpha.
- Trigger-driven templates (a `triggered: true` catalog entry reacting
  to `activeTriggers`) are a later phase; the cfg block already reserves
  no room for them, the bootstrap reserves `data-countdown`.
- The `targetIso` prop is validated (not coerced) so a bad date stays
  visible in the inspector.
