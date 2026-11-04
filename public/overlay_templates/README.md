# Overlay templates

A template is **one self-contained `<id>.html` file** that describes a piece of
on-screen graphics (a "be right back" screen, a lower-third, a ticker, …). The
overlay control app auto-discovers these files, bakes them into inert DOM at
render time, and lets the operator style + fill them from the element inspector.

Nothing is registered by hand. **Dropping a well-formed `<id>.html` file here is
the whole act of adding a template** — the server's
`GET /overlay_templates/_catalog.json` route lists the `*.html` files it finds,
and the element's template picker is built from that list.

> For the renderer's internal contract (scoping, escaping, caching) see
> [`server/modules/overlay_templates/README.md`](../../server/modules/overlay_templates/README.md).
> This file is the *authoring* guide.

---

## File layout

```
public/overlay_templates/
├── brb.html
├── countdown.html
├── header.html
├── lower_third_bar.html
├── now_playing.html
├── ticker.html
└── …
```

- **The id is the filename minus `.html`.** The id must match
  `/^[a-z0-9][a-z0-9_]*$/` (lowercase, digits, underscores; no dots, spaces, or
  dashes) — that is the slug the schema validates (`overlay_schema.ts`).
- The server exposes each template at `/overlay_templates/<id>.html` and fetches
  + parses it at runtime. There is no build step and no import of these files.

---

## Anatomy of a template

A template is a complete HTML document with **exactly these parts**:

1. a `<head>` carrying **one** required meta tag — the human name's i18n key;
2. exactly **one** `<style>` block;
3. exactly **one** `<section>` — the visual body that fills the element's box.

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <!-- REQUIRED: i18n key of the display name. Must match <id>. -->
    <meta name="overlay-template:name" content="overlay.tpl.my_template" />
    <style>
      /* ── KNOBS: every --name becomes an editable inspector field ── */
      :root {
        --accent: #6c5ce7;
        --bg: rgba(15, 15, 25, 0.92);
        --text: #ffffff;
        --radius: 12px;
        --padding: 14px;
      }

      *, *::before, *::after { box-sizing: border-box; }

      /* `section` fills the element's box — anchor everything inside it. */
      section {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        background: transparent;
      }

      .label {
        color: var(--text);
        font-size: 18px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <!-- ── BODY: one <section>, inert markup, no scripts ── -->
    <section>
      <div class="label" data-bind="title">My template</div>
    </section>
  </body>
</html>
```

The `<section>` is the **only** markup the renderer uses. Everything else in the
doc exists so you can open the file straight in a browser tab and see the design
standing alone.

---

## The hooks

The body is inert markup. A template "talks" to the element through four HTML
attributes; the parser derives the element's editable `uses` list **from them**
(nothing is hand-listed):

| Hook | Where | What it does |
|---|---|---|
| `overlay-template:name` | `<head>` `<meta>` | The template's display-name i18n key (the only tag you write by hand). |
| `data-bind="<slot>"` | any element in the `<section>` | A **text slot** named `<slot>`. Its text content is replaced at render with the element's value (entity-escaped). |
| `data-asset="logo"` | an `<img>` | Its `src` is set from the element's chosen **logo** asset (from the page's asset library). |
| `data-countdown` | one element | The renderer ticks this node live with a `HH:MM:SS` countdown to the element's target time. |

### Text slots (`data-bind`)

Any attribute name is a valid slot. `title` / `subtitle` are just the
conventional ones — a template binds whatever it needs (the `ticker` template
binds a `label` for its fixed "LIVE" chip *and* a `title` for the scrolling
line):

```html
<span class="label" data-bind="label">LIVE</span>
<span data-bind="title">Your scrolling text</span>
```

The renderer replaces each slot's inner text (it does **not** touch the tag or
its attributes), so the slot element's classes and layout survive. **A slot may
be reused** — every element carrying `data-bind="<slot>"` is filled with the
same value (the `ticker` template binds `title` twice in its scrolling track
for a seamless marquee).

**`{token}` templating.** A slot's value can embed `{tokens}` that resolve at
render time against project variables (and, for triggered overlays, the trigger
payload). e.g. an operator sets the slot to `Now playing {track}` and, when the
`track` variable is `"Bohemian Rhapsody"`, the overlay shows
`Now playing Bohemian Rhapsody`. Plain text with no tokens is fine too.

### Logo (`data-asset="logo"`)

```html
<img data-asset="logo" src="" />
```

When the element has a logo asset set, the renderer writes the asset's URL into
`src` (entity-escaped). When none is set, the `src` stays as you wrote it — so
give the `<img>` a sensible placeholder (the `now_playing` template ships a tiny
inline SVG and hides it behind a `:has(img[src])` fallback block).

### Countdown (`data-countdown`)

```html
<div class="time" data-countdown>00:00:00</div>
```

Give it a single element. The element switches to `mode: "countdown"` + a target
time in the inspector; the renderer then ticks this node once per second toward
the target. The static text you write here is just the pre-countdown placeholder.

---

## Style knobs (`:root` custom properties)

Every `--name: value` entry in the `<style>`'s `:root` block becomes an
**editable inspector field** for elements using this template, and it is the
**fallback** the render uses until the element overrides it. So `:root` must
declare a fallback for every knob you want to be tweakable.

The inspector picks a control per value shape:

| `:root` value | Inspector control |
|---|---|
| 6-digit hex (`#6c5ce7`) | colour picker |
| colour with alpha (`rgba(…)` / `hsla(…)` / `#rrggbbaa`) | colour picker + alpha slider |
| a number / `Npx`/`Nem`/`Nrem`/`N%`/`Ns` | number input (unit kept) |
| anything else (font stacks, …) | text field |

Example: `--corner-glow: rgba(108, 92, 231, 0.35)` → a "Corner glow" colour +
alpha field. **Adding a knob is adding a `--custom-property` to `:root` — no
schema change.**

Refer to knobs in your CSS with `var(--name)`:

```css
.card { padding: var(--padding); background: var(--bg); border-radius: var(--radius); }
```

Declare colours in `:root` (as custom properties) rather than as raw literals in
rules — that is what makes them editable and matches the repo's design-token
convention.

---

## Rules the parser enforces

The parser (`templates/template_doc.ts`) **fails loudly** on any of these, so a
broken template never renders half-baked:

- **Exactly one** `<section>` in the body.
- **No `<script>`** anywhere (the doc is inert; the parser and the renderer both
  reject it).
- The required `overlay-template:name` meta tag is present.
- Exactly one `<style>` block.

CSS is additionally scoped by `templates/css_scope.ts`, which rewrites the
stylesheet so it can only affect this element's wrapper:

- `:root` / `html` / `body` selectors collapse onto the wrapper;
- class selectors are prefixed with the wrapper class (`ov-tpl-<id>`);
- `*` and `::before`/`::after` get the wrapper prefix;
- `@media` recurses; `@keyframes` are renamed per template (so two elements
  using different keyframe names never collide);
- **`@import`, `@font-face`, `@supports`, `url(…)`, and external files are not
  supported** — no `<link>`, no `fetch`, no fonts, no `background: url(…)`.

---

## How to add a template

1. **Create the file.** Write `public/overlay_templates/<id>.html` following the
   anatomy above. Keep it self-contained (inline everything; no external assets).

2. **Add the display-name i18n key.** Add
   `"overlay.tpl.<id>": "Display name"` to **every** locale file in
   [`server/modules/overlay_templates/i18n/`](../../server/modules/overlay_templates/i18n)
   — `en, de, es, fr, it, ja, pl, pt, ru, cs, sk, zh` (12 files). The i18n
   test asserts every locale has *exactly* the same keys as `en.json`, so a key
   missing in even one locale fails the build. (The meta tag's `content` value
   must be this same key — `overlay.tpl.<id>`.)

3. **Register the id in the catalog test.**
   [`test/overlay_templates.test.ts`](../../test/overlay_templates.test.ts) has
   `the auto-discovered catalog is the on-disk template files`, which pins the
   exact sorted list of ids. Add your new id to that array; it must match the
   on-disk files.

4. **Preview & verify.** Open the `.html` file directly in a browser to check
   the design, then run the test suites:
   ```bash
   bun test test/overlay_templates.test.ts test/i18n.test.ts
   ```

That's it — the template now appears in the element's picker, and the inspector
auto-generates fields from its `data-bind` slots, `:root` knobs, logo, and
countdown hooks.

---

## Previewing

Open any template file directly in a browser tab. It renders standalone (the
`<section>` fills the viewport), which is how the design is reviewed before it
is ever baked into an overlay. Note the browser preview shows the *fallback*
`:root` values and placeholder slot text — the live element's overrides and
resolved `{token}`s only apply in-app.
