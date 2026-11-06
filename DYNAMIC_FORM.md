# DynamicForm

A schema-driven, translation-key-driven Mithril form generator. A `FormSchema`
is plain data describing a form; `DynamicForm` is a **controlled** Mithril
component that turns it into rendered controls. Nothing in a schema is a
display string — every label, help line, placeholder, option label and
validation message is a **translation key** resolved through the shared `t` at
render time, so switching language re-renders the form with no schema rebuild
and no reload.

> Status: the **library** (Phase A of [`TODO/06-dynamic-form.md`](TODO/06-dynamic-form.md))
> is complete and tested. The editor integrations (Phases B–E) are **not** done
> yet — see [Integration](#integration-phases-b%E2%80%93e---pending) below.

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

## Integration (Phases B–E) — pending

The spec's later phases wire `DynamicForm` into existing editors, **replacing
working code**, and assume paths that do not match the repo (they say
`server/modules/overlay_templates`, but the module lives at
`server/pages/overlays/modules/overlay_templates/`; they assume
`shared/ui/ui.tsx`, but the barrel is `shared/ui/components/index.tsx`; they
show `{name}` interpolation, but the catalogs use `{{name}}`). They are
intentionally **not** started:

| Phase | Spec intent | Real target |
| --- | --- | --- |
| B | `overlay_templates` schema + prop editor | `server/pages/overlays/modules/overlay_templates/client/` |
| C | overlays page prop editor | `server/pages/overlays/client/` |
| D | dashboards schema (optional) | `server/pages/dashboards/` |
| E | extend `test/pages_boundaries.test.ts` | five rules: import directions, catalogue parity, no hardcoded labels in schemas |

When these land, extend this doc's API section with the pre-refactor →
new-file mapping and the §9.10 "plug-a-field" / "translate-only" proof
commands.
