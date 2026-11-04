# shared/ui — the UI kit

Everything a page or a module renders with lives here, so the device UI, the
control-server UI and every module card look and behave the same. Pages and
modules import components from `components/ui` (the barrel) and never write
their own buttons, tables, toolbars or dialogs.

```
shared/ui/
├── components/
│   ├── ui.tsx            the barrel — import from here
│   ├── page.tsx          Page, TitleWithBack, Footer
│   ├── nav.tsx           ServerNav (control-server menu + profile menu)
│   ├── card.tsx          Card
│   ├── badge.tsx         Badge, ConnectionBadge
│   ├── button.tsx        Button, Actions, IconButton, IconLink
│   ├── form.tsx          Form, Field, NumberField, CheckField, FieldGroup, Break,
│   │                     Options, bound Input / Select / Checkbox, numberAttrs
│   ├── data.tsx          DefinitionList, WidgetTable
│   ├── table.tsx         Table, RowActions (entity lists)
│   ├── toolbar.tsx       Toolbar (labelled control row)
│   ├── empty_state.tsx   EmptyState
│   ├── toast.tsx         Toast, useToast
│   ├── modal.tsx         Modal
│   ├── confirm.tsx       confirmDialog (promise-based, replaces window.confirm)
│   ├── icons.tsx         Icon (the built-in 24×24 outline set), OutlineIcon
│   └── role_tag.tsx      RoleTag (pictogram from the module that owns the role)
├── overlay/              overlay element SDK (element contract, fields, registry)
├── api_client.ts         apiJson / apiTry / ApiError — the only way to call /api
├── i18n.tsx              t(), LanguageSelect, i18nReady
├── module_registry.ts    the frontend module registry (manifest-fed)
├── services/rpc.ts       the device RPC client
├── device/               device store + log card (device page and device cards)
└── util.ts               mountPage, uuid, formatters
```

The stylesheet is `shared/css/style.css`, an index over `tokens.css`,
`base.css`, `layout.css`, `components/*.css` and `pages/*.css`
(see the header of each file). Module stylesheets (`<module>/styles.css`) are
scoped under the module's card class and only hold what no shared rule
provides.

## Rules

- **Tokens, not literals.** Colours, radii, shadows and motion come from
  `shared/css/tokens.css` (`var(--accent)`, `var(--radius)`, …). A module that
  needs a colour of its own (a platform brand, a syntax palette, a role accent)
  declares it as a custom property in its own stylesheet and uses the variable;
  `test/css_tokens.test.ts` rejects a colour literal anywhere else.
- **Shared components first.** Lists are `Table` + `RowActions` with
  `IconButton` / `IconLink` actions and a `Toolbar` for creation; empty lists
  render `EmptyState`; destructive actions ask through `confirmDialog`;
  transient notices use `useToast()` + `Toast`; dialogs build on `Modal`.
- **One API client.** Browser code calls the JSON API through `apiJson` (throws
  `ApiError` with the server's message, status, code and parsed body) or
  `apiTry` (logs and resolves `null`). No raw `fetch("/api/…")`.
- **Icons.** `Icon name="…"` for the built-in set; a module's own pictograms
  (role icons, overlay element icons) are drawn with `OutlineIcon` and
  contributed through its registration (`roleIcons`, `OverlayElementDef.icon`).
- **No module ids in the kit.** The kit renders contributions (role icons,
  cards, widgets, overlay elements) through the registries; it never names a
  module, a role or an element type.

## Components

| Component | Use |
| --- | --- |
| `Page` | page skeleton: brand, `title`, `nav`, language, `headerRight`, optional `toolbar` strip, content, footer |
| `TitleWithBack` | page title with a back link (`href`, `backLabel`) |
| `ServerNav` | the control server's main menu; `active` marks the section |
| `Card` | titled content block (`title`, `headActions`, `class`) |
| `Badge`, `ConnectionBadge` | status pills (`kind: on / off / warn`) |
| `Button` | `<button>`; `label`, `type`, `class="secondary" / "danger"` |
| `IconButton`, `IconLink` | icon-only button / link: `icon`, `label` (tooltip + accessible name), `danger` |
| `Actions` | a row of buttons |
| `Form`, `Field`, `NumberField`, `CheckField`, `FieldGroup`, `Break`, `Options` | form layout |
| `Input`, `Select`, `Checkbox` | controls bound to `target[prop]` |
| `DefinitionList`, `WidgetTable` | compact read-only data |
| `Table`, `RowActions` | entity lists: `columns`, rows as children, actions cell |
| `Toolbar` | labelled control row (`label`) |
| `EmptyState` | "nothing yet" block with the creation toolbar as children |
| `Toast`, `useToast()` | one toast slot per page: `toast.show(msg, sticky?)` |
| `Modal` | scrim + centred card; `title`, `onClose` |
| `confirmDialog(message, { danger, okLabel, title })` | `Promise<boolean>` |
| `Icon`, `OutlineIcon`, `RoleTag` | pictograms |

## Adding a component

One file per component under `components/`, exported from `ui.tsx`, styled in
`components/<name>.css` (imported from `shared/css/style.css`) using tokens
only. Add a row to the table above.
