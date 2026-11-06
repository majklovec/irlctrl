# DynamicForm

A schema-driven, translation-key-driven Mithril form generator. A `FormSchema`
is plain data describing a form; `DynamicForm` is a **controlled** Mithril
component that turns it into rendered controls. Nothing in a schema is a
display string — every label, help line, placeholder, option label and
validation message is a **translation key** resolved through the shared `t` at
render time, so switching language re-renders the form with no schema rebuild
and no reload.

> Status: the **library** (Phase A of [`TODO/06-dynamic-form.md`](TODO/06-dynamic-form.md))
> is complete and tested, and the editor integrations (Phases B–E) are **done**
> — see [Integration](#integration-phases-b%E2%80%93e) below.

## Placement — `shared/ui/`, not `server/ui/`

DynamicForm lives in [`shared/ui/components/dynamic_form.tsx`](shared/ui/components/dynamic_form.tsx)
because both **pages** and **dashboard widget modules** consume it, whereas
`server/ui/` is scoped to pages only. Its imports are restricted to
`shared/ui/components/form.tsx` (`FieldGroup`), `shared/ui/i18n.tsx` (`t`),
`shared/ui/jsx` (types) and Mithril — **never** `server/` — a boundary
[`test/pages_boundaries.test.ts`](test/pages_boundaries.test.ts) pins.

## Translation strategy

- **Keys, never strings.** `FieldSchema.labelKey`, `helpKey`,
  `placeholderKey`, `GroupSchema.legendKey`, `FieldOption.labelKey` and
  `validate`'s return value are all keys. `resolve(t, key, params)` runs them
  through `t`; a missing key (i18next falls back to the raw key) is shown as
  the raw key and logged **once** (module-level `warned` set), so a UI never
  renders an empty label. User data is never routed through `resolve`.
- **`labelParams` path resolution.** A string `labelParams` value that names a
  dotted path present in the live value is replaced by the value at that path
  (`resolveParams`), so `labelParams: { name: "vars.name" }` interpolates the
  live `vars.name`. Non-path strings pass through as literals.
- **i18next interpolation is `{{var}}`** (not the `{name}` the original spec
  sketch used). Placeholders in JSON catalogs are `{{name}}`.
- **Parity rule (enforced by [`test/i18n.test.ts`](test/i18n.test.ts)).** All 12
  core locales (`i18n/*.json`) carry the **same key set** and the **same
  `{{placeholder}}` names**. Add a `dynamic_form.*` key to **every** locale in
  lockstep. The four `dynamic_form.*` keys (`missing_key`, `required`,
  `invalid_number`, `invalid_iso`) are present in all 12.
- **Injectable `t`.** `DynamicFormAttrs.t` defaults to the shared `t`
  ([`shared/ui/i18n.tsx`](shared/ui/i18n.tsx)); override it per-render to test
  or to scope translations.

## API

Exported from [`shared/ui/components/index.tsx`](shared/ui/components/index.tsx):

| Export | Purpose |
| --- | --- |
| `DynamicForm` | Controlled Mithril component. Attrs: `schema`, `value`, `onChange?`, `onSubmit?`, `disabled?`, `t?`. |
| `FormSchema` / `FormFieldSchema` | `{ fields: (FieldSchema \| GroupSchema)[] }`. |
| `FieldSchema` | One control. `type` is a `FieldType`; `name` is a dotted path; label/help/placeholder via `*Key` + `*Params`; `required?`, `options?`, `min?/max?/step?`, `visibleWhen?`, `validate?`. |
| `GroupSchema` | `{ type: "group", legendKey, legendParams?, fields }` — renders a `<fieldset>`/`<legend>` via `FieldGroup`; may nest. |
| `FieldType` | `text \| textarea \| number \| range \| select \| checkbox \| color \| asset \| iso-datetime`. |
| `FieldOption` | `{ value, labelKey, labelParams? }` for `select`/`asset`. |
| `Translate` | `(key, params?) => string` — the signature of `t`. |
| `getPath` / `setPath` | Read / clone-on-write a dotted path ("a.b") in a plain-object state tree. |
| `resolve` | Translate a key through `t` with the missing-key → raw-key fallback. |

### Control binding

`DynamicForm` does **not** reuse the `Input`/`Select`/`Checkbox` atoms from
`form.tsx` (they assign `state[prop] = value`, which is flat and cannot express
dotted paths like `vars.accent`). `controlFor` builds raw control vnodes that
read `getPath(value, name)` and write back a **new** object through
`setPath` → `onChange(next)`, so `vars.accent`-style state round-trips and the
caller's `value` object is never mutated.

## Adding a field / a translation

Add a **field type**: implement its branch in `controlFor` (this file), add the
type to `FieldType`, add a test in [`test/dynamic_form.test.ts`](test/dynamic_form.test.ts).
Add a **translation**: add the key to all 12 `i18n/*.json` — no other change.
A **caller** only supplies a `FormSchema` and the `value`/`onChange` wiring.

## Verification (Phase A)

- [`test/dynamic_form.test.ts`](test/dynamic_form.test.ts) — 21 tests, green
  (field types, dotted-path round-trip, no-value-mutation, `labelParams` live
  resolution, `t` re-render, missing-key fallback + warn-once, `visibleWhen`,
  groups, `validate`/`required`).
- `bun test` — the 9 pre-existing baseline failures are unchanged (encoder i18n
  drift, twitch badge parsing, Kick watchdog, overlay_templates); the four new
  core `dynamic_form.*` keys are in parity across all 12 locales.
- `tsc --noEmit` — no errors in the library.
- `bun run build:client` and `bun run build:server` — both compile.

## Integration (Phases B–E) — done

The spec's later phases wire the form into the overlay editors, **replacing
working code**. The spec's paths do not match the repo (it says
`server/modules/overlay_templates`, but the module lives at
`server/pages/overlays/modules/overlay_templates/`; it assumes `shared/ui/ui.tsx`,
but the barrel is `shared/ui/components/index.tsx`; it shows `{name}`
interpolation, but the catalogs use `{{name}}`). All phases landed on the
real paths:

| Phase | What landed | Real location |
| --- | --- | --- |
| **B** | `overlay_templates` html_template editor on `bindableForm` (vars form) | [`server/pages/overlays/modules/overlay_templates/element.tsx`](server/pages/overlays/modules/overlay_templates/element.tsx) |
| **C** | all 21 per-element `editForm`s migrated from raw `bindField` + `ov-gridN` divs to data-driven `bindableForm` rows, 1:1 behavior | [`server/pages/overlays/modules/overlay_elements/elements/*.tsx`](server/pages/overlays/modules/overlay_elements/elements/) |
| **D** | dashboards schema — **evaluated and skipped** (see below) | [`server/pages/dashboards/`](server/pages/dashboards/) |
| **E** | five DynamicForm boundary tests | [`test/pages_boundaries.test.ts`](test/pages_boundaries.test.ts) |

### The `bindableForm` editor surface

The element editors do not consume `DynamicForm` directly. They use the
thinner `bindableForm` helper in
[`shared/ui/overlay/fields.tsx`](shared/ui/overlay/fields.tsx), which shares
`makeControl` with `DynamicForm` (same 9 control branches in
[`dynamic_form.tsx`](shared/ui/components/dynamic_form.tsx)). `bindableForm`
takes `{ element, mutate, variables, variableUrl?, rows }` and renders each
`FormRow` = `FormField[] | Vnode`:

- a **`FormField[]`** row becomes an `ov-grid` (`1` → bare `.ov-field`,
  `2` → `.ov-grid2`, `3` → `.ov-grid3`), each field a `makeControl` with a
  bindable wrapper; `path: "props.<key>"` sets the prop key, `labelKey` is the
  `t("…")` key, `value` is the same read expression the raw control used;
- a bare **`Vnode`** row is the escape hatch, rendered verbatim — never given
  a binding toggle.

#### 1:1 migration rules (Phase C)

- A **`select` descriptor writes a string** (no `Number()` coercion). Any prop
  that is number-typed *and* read via `numProp` in `draw()` must stay a raw
  `bindField` Vnode row, else the string silently falls back to the default
  (e.g. `text.tsx` `fontWeight`).
- **Nested object props** (e.g. `live_map` `startPosition.lat/.lon`) stay raw
  Vnode rows — descriptors only do flat `props.<key>` writes.
- **`color`** controls standardized on `oninput` (live-drag), matching every
  editor; `text`/`number`/`range` are `oninput`, `select`/`checkbox`/
  `iso-datetime`/`asset` are `onchange`; `number` writes `Number(…)`
  (NaN → `0`).
- **Component-type widgets** (e.g. `weather` `GeoFillButton`) cast with
  `m(…) as Vnode` in a `FormRow[]`.
- **i18n:** keep the `t` import in an editor only while raw widgets / option
  labels / `draw` still use it.

### Phase D — why dashboards were skipped

The dashboards widget-config form is **contract-driven** — a
`WidgetConfigField` list with async, module-supplied select options
([`widget_config_select.tsx`](server/pages/dashboards/frontend/widget_config_select.tsx))
and string-typed config — not the element-props `mutate` model that
`bindableForm`/`DynamicForm` target. Forcing it onto the library would add an
adapter for no behavioral gain, so it is intentionally **not** converted;
`DynamicForm` remains available there if a future dashboard surface becomes
schema-shaped.

### Phase E — boundary tests

Five tests in the `dynamic form boundaries` block of
[`test/pages_boundaries.test.ts`](test/pages_boundaries.test.ts):

1. `dynamic_form.tsx` is a `shared/` leaf — no runtime import from `server/`;
2. `overlay/fields.tsx` reaches `server/` only via type imports (values come
   from the caller);
3. element editors are leaf UI — no runtime import from another page;
4. the overlay i18n catalogues (`overlay_elements` and `dashboards/chat`)
   keep key-set parity across all 12 locales;
5. every `labelKey:` an element editor references resolves in its catalogue —
   the stale-key detector (this caught a pre-existing missing
   `overlay.live_map_zoom` key, now added to all 12 locales).

### Verification (Phases B–E)

- `bun test` — 388 pass / 9 fail; the 9 are the pre-existing baseline
  (twitch badge, Kick watchdog, i18next parity, overlay_templates, webcam),
  unchanged — no new failures.
- `test/overlay_elements.test.ts` (17), `test/overlay_fields.test.ts` (11),
  `test/dynamic_form.test.ts` (21), `test/overlay_templates_vars_form.test.ts`
  (2), `test/pages_boundaries.test.ts` (9) — all green.
- `tsc --noEmit` — no errors in any migrated editor, `fields.tsx`,
  `dynamic_form.tsx`, `element.tsx`, or the boundaries test.
- `i18n` — all 12 locales in parity (238 keys each after the
  `overlay.live_map_zoom` fix).
