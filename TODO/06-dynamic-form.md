# Implement the DynamicForm library in the post-refactor `pages/` architecture

## 0. Mission

Build the reusable **`DynamicForm`** library (schema‑driven UI generator) and integrate it into three surfaces — the **Dashboards** page, the **Overlays** page, and the **`overlay_templates`** widget module — **after** the companion refactor handoff ("Refactor control server into pluggable `pages/` slices") has landed.

All user‑facing labels use the shared translation function `t` — no hardcoded strings in schemas, no hardcoded strings in `DynamicForm`.

The end state:
- `DynamicForm` lives in **`shared/ui/`** so it can be consumed by both pages and dashboard widget modules.
- Every label in every `FormSchema` is a **translation key** resolved through `t` at render time. Switching the UI language re‑renders forms without rebuilding schemas.
- The `overlay_templates` module owns its `HtmlTemplateProps` schema builder and consumes `DynamicForm` to render the HTML‑template property editor inside the dashboard widget config.
- The **Overlays** page consumes `DynamicForm` for the overlay element property editor.
- The **Dashboards** page consumes `DynamicForm` only if it needs a generic surface of its own; widget prop editors are still supplied by modules.
- The new page architecture is untouched: no edits outside `shared/ui/`, `server/modules/overlay_templates/`, `server/pages/overlays/`, `server/pages/dashboards/`, and the translation catalogue.

---

## 1. Prerequisites — the refactor must be green

Before starting, confirm the refactor handoff is complete:

```bash
bun test
bun run build:client
bun run build:server
```

Expected state:
- `server/core/contracts.ts`, `server/core/registry.ts`, `server/core/app.ts`, `server/core/services.ts` exist.
- `server/pages/{devices,dashboards,overlays}/` slices exist and each has `index.ts`, `client/page.tsx`, `client/menu.ts`, `server/routes.ts`.
- `server/ui/` and `server/shell/` exist.
- `scripts/gen_pages.ts` is wired into `package.json` (`predev`, `pretest`, `prebuild:*`).
- `test/pages_boundaries.test.ts` passes.
- The widget module system (`shared/registry.ts`, `scripts/gen_modules.ts`, `server/modules/`) is unchanged and green.
- A translation facility exists and exposes `t(key, params?)`. Locate its module (likely `shared/i18n/` or `shared/translations/`) and note the catalogue file(s) that must be extended.

Reconnaissance — read these in the new tree:

| Area                     | Paths                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refactored composition   | `server/core/contracts.ts`, `server/core/registry.ts`, `server/core/app.ts`, `server/main.ts`                                                                          |
| Page slices              | `server/pages/dashboards/`, `server/pages/overlays/` — `client/`, `server/`, `shared/`                                                                                 |
| Shared UI (unchanged)    | `shared/ui/`, `shared/ui/components/form.tsx` (existing `Form`, `Field`, `FieldGroup`, `Input`, `Select`, `Checkbox`, `numberAttrs`)                                   |
| **Translation facility** | Locate `t` — typically `shared/i18n/index.ts` + `shared/i18n/cs.ts`, `shared/i18n/en.ts`. Confirm the API: `t(key: string, params?: Record<string, unknown>): string`. |
| Page UI (new)            | `server/ui/` — extract only if there is a genuine page‑only atom; do **not** move DynamicForm here (see §2)                                                            |
| Widget modules           | `server/modules/` — especially `server/modules/overlay_templates/` (`overlay_schema.ts`, `frontend.tsx`)                                                               |
| Module contracts         | `shared/contracts/frontend_module.ts`, `shared/contracts/backend_module.ts`                                                                                            |
| Existing Mithril inputs  | `shared/ui/components/form.tsx` — reuse, do not reimplement                                                                                                            |
| Overlay types            | `server/pages/overlays/shared/types.ts` (after refactor)                                                                                                               |
| HTML template schema     | `server/modules/overlay_templates/overlay_schema.ts` — `HtmlTemplateProps`, `DEFAULT_HTML_TEMPLATE_PROPS`, `parseRootVars`                                             |

---

## 2. Target placement — where each piece lives after the refactor

```
shared/
├─ i18n/
│  ├─ index.ts                        ← exports t(); already exists
│  ├─ cs.ts                           ← extend with new keys
│  └─ en.ts                           ← extend with new keys
└─ ui/
   ├─ components/
   │  ├─ form.tsx                     ← existing atoms (Form, Field, …)
   │  └─ dynamic_form.tsx             ← NEW: the generic library
   └─ ui.tsx                          ← barrel: re-export dynamic_form

server/
├─ ui/                                ← page-only atoms (unchanged by this handoff)
│
├─ pages/
│  ├─ dashboards/
│  │  └─ client/
│  │     └─ components/
│  │        └─ widget_config_panel.tsx    ← unchanged: renders the module’s
│  │                                        own prop editor
│  │
│  └─ overlays/
│     ├─ client/
│     │  ├─ components/
│     │  │  └─ overlay_prop_editor.tsx   ← uses DynamicForm
│     │  └─ schema.ts                    ← overlay-specific FormSchema builder
│     └─ shared/
│        └─ types.ts                     ← overlay element DTOs
│
└─ modules/
   └─ overlay_templates/
      ├─ overlay_schema.ts              ← HtmlTemplateProps + DEFAULT_* + parseRootVars
      ├─ frontend.tsx                   ← existing module client contribution
      └─ client/
         ├─ schema.ts                   ← NEW: schemaFromHtmlTemplateProps
         └─ prop_editor.tsx             ← NEW: OverlayTemplatePropEditor (uses DynamicForm)
```

**Dependency rules (still hold after this handoff):**
- `shared/ui/dynamic_form.tsx` imports only from `shared/ui/components/form.tsx`, `shared/i18n/`, and Mithril. It **must not** import from `server/` or from any module.
- `server/modules/overlay_templates/client/*` may import from `shared/ui/` and its own module — never from `server/pages/`.
- `server/pages/overlays/client/*` may import from `shared/ui/` — never from `server/modules/`.
- `server/pages/dashboards/client/*` renders module‑supplied prop editors; it does not know about `overlay_templates`.

> **Why `shared/ui/` and not `server/ui/`?** Both pages _and_ widget modules consume `DynamicForm`.`server/ui/` is scoped to pages (per the refactor’s dependency graph). Putting the library in `shared/ui/` keeps the same code usable from the module side without inverting the layer direction.

---

## 3. Translation strategy — everything goes through `t`

Rules:
1. **Schemas store translation keys, not strings.** `FieldSchema.label` is replaced by `labelKey` (plus optional `labelParams`). Same for `GroupSchema.legendKey` and `FieldSchema.helpKey` / `placeholderKey`.
2. **`DynamicForm` resolves keys at render time** by calling the shared `t`. Language switches trigger a re‑render and pick up the new strings automatically.
3. **Interpolation** uses `t`’s existing `params` support (`t(key, { name })`) — no manual string concatenation in schemas.
4. **Fallbacks:** `DynamicForm` accepts an optional `t` override via attrs (used in tests) and defaults to the shared `t`. If a `labelKey` is missing, log a warning and fall back to the raw key so the UI never renders empty.
5. **Catalogue layout:** keys live under `dynamic_form.*`, `overlays.prop.*`, `overlay_templates.prop.*`, `dashboards.meta.*`. Both `cs.ts` and `en.ts` must be extended in the same commit.
6. **No translation of user data.** Values like `widgetConfig.props.title` (user‑entered) are never passed through `t`. Only labels, help texts, placeholders and option labels are.

---

## 4. The library — `shared/ui/components/dynamic_form.tsx`

### 4.1 Types

```ts
// shared/ui/components/dynamic_form.tsx
export type FieldType =
	| "text"
	| "textarea"
	| "number"
	| "range"
	| "select"
	| "checkbox"
	| "color"
	| "asset"
	| "iso-datetime";

export interface FieldOption {
	value: string;
	labelKey: string; // translated at render time
	labelParams?: Record<string, unknown>;
}

export interface FieldSchema {
	type: FieldType;
	name: string; // supports "a.b" for nested keys

	labelKey: string; // required — translation key
	labelParams?: Record<string, unknown>;

	helpKey?: string;
	helpParams?: Record<string, unknown>;

	placeholderKey?: string;
	placeholderParams?: Record<string, unknown>;

	required?: boolean;
	defaultValue?: unknown;
	options?: FieldOption[]; // select / asset

	min?: number; // number / range
	max?: number; // number / range
	step?: number; // number / range

	visibleWhen?: { field: string; equals: unknown };
	validate?: (value: unknown) => string | null;
}

export interface GroupSchema {
	type: "group";
	legendKey: string;
	legendParams?: Record<string, unknown>;
	fields: FormFieldSchema[];
}

export type FormFieldSchema = FieldSchema | GroupSchema;

export interface FormSchema {
	fields: FormFieldSchema[];
}
```

### 4.2 Component

`DynamicForm` remains a **controlled** Mithril component: it accepts `value: Record<string, unknown>` and emits `onChange(next)`. Dotted names (`vars.accent`) are expanded via the shared `getPath` / `setPath` helpers.

```tsx
import m from "mithril";
import { t as sharedT } from "../../i18n";
import {
	Form,
	Field,
	FieldGroup,
	Input,
	Select,
	Checkbox,
	numberAttrs,
} from "./form";

export const DynamicForm = {
	view: ({
		attrs: { schema, value, onChange, onSubmit, disabled, t = sharedT },
	}) => {
		const state = value ?? {};
		const handleChange = (name: string, v: unknown) =>
			onChange?.(setPath(state, name, v));

		return m(
			Form,
			{ onSubmit },
			schema.fields.map((f) =>
				f.type === "group"
					? m(
							FieldGroup,
							{ legend: resolve(t, f.legendKey, f.legendParams) },
							f.fields.map((child) =>
								renderField(child, state, handleChange, disabled, t),
							),
						)
					: renderField(f, state, handleChange, disabled, t),
			),
		);
	},
} as MithrilJSXComponent<{
	schema: FormSchema;
	value: Record<string, unknown>;
	onChange?: (next: Record<string, unknown>) => void;
	onSubmit?: () => void;
	disabled?: boolean;
	t?: (key: string, params?: Record<string, unknown>) => string;
}>;
```

### 4.3 Field renderer — `renderField`

```tsx
function renderField(
	f: FieldSchema,
	state: Record<string, unknown>,
	handleChange: (name: string, v: unknown) => void,
	disabled: boolean | undefined,
	t: Translate,
): m.Children {
	if (
		f.visibleWhen &&
		getPath(state, f.visibleWhen.field) !== f.visibleWhen.equals
	) {
		return null;
	}

	const label = resolve(t, f.labelKey, f.labelParams);
	const help = f.helpKey ? resolve(t, f.helpKey, f.helpParams) : undefined;
	const placeholder = f.placeholderKey
		? resolve(t, f.placeholderKey, f.placeholderParams)
		: undefined;

	// each branch builds the control; examples:
	switch (f.type) {
		case "text":
		case "textarea":
			return m(Field, {
				label,
				help,
				control: m(Input, {
					target: state,
					prop: f.name,
					placeholder,
					disabled,
					onchange: (e: Event) =>
						handleChange(f.name, (e.target as HTMLInputElement).value),
				}),
			});

		case "number":
			return m(Field, {
				label,
				help,
				control: m(Input, {
					target: state,
					prop: f.name,
					...numberAttrs(f.min ?? 0, f.max ?? 100, placeholder, f.step),
					disabled,
					onchange: (e: Event) =>
						handleChange(f.name, Number((e.target as HTMLInputElement).value)),
				}),
			});

		case "range":
			return m(Field, {
				label,
				help,
				control: m("input", {
					type: "range",
					min: f.min ?? 0,
					max: f.max ?? 100,
					step: f.step ?? 1,
					disabled,
					value: getPath(state, f.name) as number,
					oninput: (e: Event) =>
						handleChange(f.name, Number((e.target as HTMLInputElement).value)),
				}),
			});

		case "select":
		case "asset":
			return m(Field, {
				label,
				help,
				control: m(
					Select,
					{
						target: state,
						prop: f.name,
						disabled,
						onchange: (e: Event) =>
							handleChange(f.name, (e.target as HTMLSelectElement).value),
					},
					(f.options ?? []).map((opt) =>
						m(
							"option",
							{ value: opt.value },
							resolve(t, opt.labelKey, opt.labelParams),
						),
					),
				),
			});

		case "checkbox":
			return m(CheckField, {
				label,
				help,
				control: m(Checkbox, {
					target: state,
					prop: f.name,
					disabled,
					onchange: (e: Event) =>
						handleChange(f.name, (e.target as HTMLInputElement).checked),
				}),
			});

		case "color":
			return m(Field, {
				label,
				help,
				control: m(Input, {
					target: state,
					prop: f.name,
					type: "color",
					disabled,
					onchange: (e: Event) =>
						handleChange(f.name, (e.target as HTMLInputElement).value),
				}),
			});

		case "iso-datetime":
			return m(Field, {
				label,
				help,
				control: m(Input, {
					target: state,
					prop: f.name,
					type: "datetime-local",
					disabled,
					onchange: (e: Event) =>
						handleChange(f.name, toIso((e.target as HTMLInputElement).value)),
				}),
			});
	}
}
```

Helper:

```ts
type Translate = (key: string, params?: Record<string, unknown>) => string;

function resolve(
	t: Translate,
	key: string,
	params?: Record<string, unknown>,
): string {
	const out = t(key, params);
	if (!out || out === key) {
		// warn once per missing key in dev
		if (import.meta.env?.DEV)
			console.warn(`[dynamic_form] missing translation: ${key}`);
		return key;
	}
	return out;
}
```

### 4.4 Barrel export

Add `export * from "./dynamic_form";` to `shared/ui/ui.tsx` so both pages and modules can consume it without deep paths.

### 4.5 Tests — `test/dynamic_form.test.ts`

Unit tests (Mithril rendering via `mithril/test-utils`, or the repo’s existing DOM harness):
1. Every `FieldType` renders the correct input.
2. `onChange` receives the merged state with dotted keys correctly expanded.
3. **Label resolution:** the injected `t` is called with each schema’s `labelKey` (and `labelParams`); changing `t`’s output changes the rendered label — no rebuild of the schema required.
4. **Option resolution:** `select` / `asset` option labels go through `t` with their `labelKey`.
5. **Fallback:** a missing key renders the key itself and logs once.
6. `visibleWhen` hides the field.
7. `GroupSchema` renders a `FieldGroup` with `legendKey` resolved through `t` and nested fields.
8. `validate` results surface on the corresponding `Field`.

---

## 5. Translation catalogue — extend `shared/i18n/`

Add keys to **both** `cs.ts` and `en.ts` (all locales must stay in sync — the boundary test in §10 enforces this).

### 5.1 Shared library keys

```ts
// shared/i18n/cs.ts  (excerpt)
"dynamic_form.missing_key": "Chybí překlad: {key}",
"dynamic_form.required": "Povinné pole",
"dynamic_form.invalid_number": "Zadejte platné číslo",
"dynamic_form.invalid_iso": "Zadejte platné datum a čas",
```

```ts
// shared/i18n/en.ts  (excerpt)
"dynamic_form.missing_key": "Missing translation: {key}",
"dynamic_form.required": "Required field",
"dynamic_form.invalid_number": "Enter a valid number",
"dynamic_form.invalid_iso": "Enter a valid date and time",
```

### 5.2 Overlay templates module keys

```ts
// shared/i18n/cs.ts
"overlay_templates.prop.title":              "Titulek",
"overlay_templates.prop.subtitle":           "Podtitulek",
"overlay_templates.prop.accentColor":        "Akcentní barva",
"overlay_templates.prop.bgColor":            "Barva pozadí",
"overlay_templates.prop.bgAlpha":            "Průhlednost pozadí",
"overlay_templates.prop.textColor":          "Barva textu",
"overlay_templates.prop.fontFamily":         "Font",
"overlay_templates.prop.fontSize":           "Velikost písma",
"overlay_templates.prop.radius":             "Zaoblení rohů",
"overlay_templates.prop.padding":            "Vnitřní odsazení",
"overlay_templates.prop.logoAssetId":        "Logo",
"overlay_templates.prop.mode":               "Režim",
"overlay_templates.prop.mode.static":        "Statický",
"overlay_templates.prop.mode.countdown":     "Odpočet",
"overlay_templates.prop.targetIso":          "Cílový čas",
"overlay_templates.prop.var":                "Proměnná {name}",

"overlay_templates.prop.font.system":        "Systémový",
"overlay_templates.prop.font.sans":          "Sans-serif",
"overlay_templates.prop.font.serif":         "Serif",
"overlay_templates.prop.font.mono":          "Monospace",
```

### 5.3 Overlays page keys

```ts
// shared/i18n/cs.ts
"overlays.prop.text":           "Text",
"overlays.prop.fontSize":       "Velikost písma",
"overlays.prop.color":          "Barva",
"overlays.prop.fontFamily":     "Font",
"overlays.prop.font.sans":      "Sans-serif",
"overlays.prop.font.serif":     "Serif",
"overlays.prop.font.mono":      "Monospace",
```

Mirror everything in `en.ts`.

---

## 6. Overlay templates module — `server/modules/overlay_templates/`

The refactor keeps the widget‑module system intact: `overlay_templates` remains a dashboard widget module in `server/modules/`. Add **two new files** and extend `frontend.tsx`; do not relocate `overlay_schema.ts`.

### 6.1 `client/schema.ts`

```ts
import type { FormSchema } from "../../../../shared/ui/components/dynamic_form";
import { DEFAULT_HTML_TEMPLATE_PROPS, parseRootVars } from "../overlay_schema";

export interface OverlaySchemaOptions {
	templateHtml?: string; // raw HTML — parseRootVars extracts :root vars
	fontOptions?: { value: string; labelKey: string }[];
	assetOptions?: { value: string; labelKey: string }[];
}

export function schemaFromHtmlTemplateProps(
	opts: OverlaySchemaOptions = {},
): FormSchema {
	const d = DEFAULT_HTML_TEMPLATE_PROPS;

	const fields: FormSchema["fields"] = [
		{
			type: "text",
			name: "title",
			labelKey: "overlay_templates.prop.title",
			defaultValue: d.title,
		},
		{
			type: "text",
			name: "subtitle",
			labelKey: "overlay_templates.prop.subtitle",
			defaultValue: d.subtitle,
		},
		{
			type: "color",
			name: "accentColor",
			labelKey: "overlay_templates.prop.accentColor",
			defaultValue: d.accentColor,
		},
		{
			type: "color",
			name: "bgColor",
			labelKey: "overlay_templates.prop.bgColor",
			defaultValue: d.bgColor,
		},
		{
			type: "range",
			name: "bgAlpha",
			labelKey: "overlay_templates.prop.bgAlpha",
			min: 0,
			max: 100,
			step: 1,
			defaultValue: d.bgAlpha,
		},
		{
			type: "color",
			name: "textColor",
			labelKey: "overlay_templates.prop.textColor",
			defaultValue: d.textColor,
		},
		{
			type: "select",
			name: "fontFamily",
			labelKey: "overlay_templates.prop.fontFamily",
			options: opts.fontOptions ?? [
				{ value: d.fontFamily, labelKey: "overlay_templates.prop.font.system" },
				{ value: "sans", labelKey: "overlay_templates.prop.font.sans" },
				{ value: "serif", labelKey: "overlay_templates.prop.font.serif" },
				{ value: "mono", labelKey: "overlay_templates.prop.font.mono" },
			],
			defaultValue: d.fontFamily,
		},
		{
			type: "range",
			name: "fontSize",
			labelKey: "overlay_templates.prop.fontSize",
			min: 6,
			max: 400,
			step: 1,
			defaultValue: d.fontSize,
		},
		{
			type: "range",
			name: "radius",
			labelKey: "overlay_templates.prop.radius",
			min: 0,
			max: 500,
			step: 1,
			defaultValue: d.radius,
		},
		{
			type: "range",
			name: "padding",
			labelKey: "overlay_templates.prop.padding",
			min: 0,
			max: 200,
			step: 1,
			defaultValue: d.padding,
		},
		{
			type: "asset",
			name: "logoAssetId",
			labelKey: "overlay_templates.prop.logoAssetId",
			options: opts.assetOptions ?? [],
			defaultValue: d.logoAssetId,
		},
		{
			type: "select",
			name: "mode",
			labelKey: "overlay_templates.prop.mode",
			options: [
				{ value: "static", labelKey: "overlay_templates.prop.mode.static" },
				{
					value: "countdown",
					labelKey: "overlay_templates.prop.mode.countdown",
				},
			],
			defaultValue: d.mode,
		},
		{
			type: "iso-datetime",
			name: "targetIso",
			labelKey: "overlay_templates.prop.targetIso",
			defaultValue: d.targetIso,
			visibleWhen: { field: "mode", equals: "countdown" },
		},
	];

	if (opts.templateHtml) {
		const rootVars = parseRootVars(opts.templateHtml);
		for (const [varName, varValue] of Object.entries(rootVars)) {
			fields.push({
				type: "color",
				name: `vars.${varName}`,
				labelKey: "overlay_templates.prop.var",
				labelParams: { name: varName },
				defaultValue: varValue,
			});
		}
	}

	return { fields };
}
```

### 6.2 `client/prop_editor.tsx`

```tsx
import m from "mithril";
import { DynamicForm } from "../../../../shared/ui/components/dynamic_form";
import {
	DEFAULT_HTML_TEMPLATE_PROPS,
	type HtmlTemplateProps,
} from "../overlay_schema";
import { schemaFromHtmlTemplateProps } from "./schema";

export const OverlayTemplatePropEditor = {
	view: ({ attrs: { props, templateHtml, onChange } }) => {
		const schema = schemaFromHtmlTemplateProps({ templateHtml });

		return m(DynamicForm, {
			schema,
			value: { ...DEFAULT_HTML_TEMPLATE_PROPS, ...props } as Record<
				string,
				unknown
			>,
			onChange: (next) => onChange?.(coerceHtmlProps(next)),
		});
	},
} as MithrilJSXComponent<{
	props: HtmlTemplateProps;
	templateHtml?: string;
	onChange?: (next: HtmlTemplateProps) => void;
}>;
```

`coerceHtmlProps` expands `vars.*` dotted keys back into the nested `vars` object and validates numeric ranges.

### 6.3 Wire into `frontend.tsx`

The module’s existing client contribution (registered via `shared/contracts/frontend_module.ts`) keeps the same shape — only the internals of the widget config editor change:

```tsx
// inside server/modules/overlay_templates/frontend.tsx
import { OverlayTemplatePropEditor } from "./client/prop_editor";

// in the widget config UI you already render:
m(OverlayTemplatePropEditor, {
	props: widgetConfig.props,
	templateHtml: currentTemplateHtml,
	onChange: (next) => saveWidgetProps(next),
});
```

No changes to `shared/registry.ts`, `scripts/gen_modules.ts`, or `shared/contracts/frontend_module.ts`.

---

## 7. Overlays page — `server/pages/overlays/`

The overlays page is a **page slice** after the refactor. It gets its own overlay element property editor, consuming `DynamicForm` from `shared/ui/`. All labels go through `t` via `labelKey`.

### 7.1 `client/schema.ts`

```ts
import type { FormSchema } from "../../../../shared/ui/components/dynamic_form";

export interface OverlayElementProps {
	text: string;
	fontSize: number;
	color: string;
	fontFamily: string;
}

export function overlayElementSchema(): FormSchema {
	return {
		fields: [
			{
				type: "text",
				name: "text",
				labelKey: "overlays.prop.text",
				required: true,
			},
			{
				type: "range",
				name: "fontSize",
				labelKey: "overlays.prop.fontSize",
				min: 8,
				max: 72,
				step: 1,
				defaultValue: 24,
			},
			{
				type: "color",
				name: "color",
				labelKey: "overlays.prop.color",
				defaultValue: "#ffffff",
			},
			{
				type: "select",
				name: "fontFamily",
				labelKey: "overlays.prop.fontFamily",
				options: [
					{ value: "sans", labelKey: "overlays.prop.font.sans" },
					{ value: "serif", labelKey: "overlays.prop.font.serif" },
					{ value: "mono", labelKey: "overlays.prop.font.mono" },
				],
			},
		],
	};
}
```

### 7.2 `client/components/overlay_prop_editor.tsx`

```tsx
import m from "mithril";
import { DynamicForm } from "../../../../../shared/ui/components/dynamic_form";
import { overlayElementSchema, type OverlayElementProps } from "../schema";

export const OverlayPropEditor = {
	view: ({ attrs: { props, onChange } }) =>
		m(DynamicForm, {
			schema: overlayElementSchema(),
			value: props as Record<string, unknown>,
			onChange: (next) => onChange?.(next as OverlayElementProps),
		}),
} as MithrilJSXComponent<{
	props: OverlayElementProps;
	onChange?: (next: OverlayElementProps) => void;
}>;
```

Use this component wherever the overlays page previously rendered its hand‑written editor. The page’s `client/page.tsx` and `server/routes.ts` need no architectural change — only the JSX inside the prop editor is replaced.

---

## 8. Dashboards page — `server/pages/dashboards/`

The dashboards page does **not** need to know about `overlay_templates`. It keeps rendering the widget‑module‑supplied config UI (unchanged contract via `shared/contracts/frontend_module.ts`). The only change is that, once §6 lands, the `overlay_templates` module's own contribution renders `OverlayTemplatePropEditor` internally.

If the dashboards page has a generic config surface of its own (e.g. dashboard metadata: title, refresh interval), it may adopt `DynamicForm` too — define `dashboardMetadataSchema()` in `server/pages/dashboards/client/schema.ts`, using `dashboards.meta.*` translation keys, and use `DynamicForm` there. This is optional and must not introduce a dependency on `overlay_templates`.

---

## 9. Build and generation

- **`scripts/gen_control_server_assets.ts`** — the shell already imports the barrel `shared/ui/ui.tsx`, which now re‑exports `dynamic_form.tsx`, and the i18n module is already bundled. Verify the generated bundle includes the new file (no extra wiring expected, but confirm with a grep on the generated bundle).
- **`scripts/gen_modules.ts`** — untouched. The `overlay_templates` module still exports a `frontend.tsx` with the same public shape.
- **`scripts/gen_pages.ts`** — untouched. `DynamicForm` is a UI atom, not a page.
- **`bun run build:client`** — must still produce a device binary; the device bundle does not use `DynamicForm`, but the shared barrel is now slightly larger. Verify the tree‑shaker still drops it from the device bundle (Mithril projects typically do; if not, import `dynamic_form` from a deep path in page/module code).

---

## 10. Migration plan — phases

All phases keep `bun test` green and both `cs.ts` / `en.ts` in sync.

### Phase A — Library only

1. Add `shared/ui/components/dynamic_form.tsx` and export it from `shared/ui/ui.tsx`.
2. Add shared keys (`dynamic_form.*`) to `cs.ts` and `en.ts`.
3. Add `test/dynamic_form.test.ts` (including the label‑resolution tests in §4.5).
4. Run `bun test`, `bun run build:client`, `bun run build:server`.

At this point nothing in the app uses the library; the baseline is green.

### Phase B — Overlay templates module

1. Add `server/modules/overlay_templates/client/schema.ts` and `client/prop_editor.tsx`.
2. Add `overlay_templates.prop.*` keys to `cs.ts` and `en.ts`.
3. Update `server/modules/overlay_templates/frontend.tsx` to render `OverlayTemplatePropEditor`.
4. Smoke test: open the dashboard that uses the HTML‑template widget; the prop editor regenerates identically to the pre‑refactor UI. `:root` variables from the current template appear as extra color fields with the `overlay_templates.prop.var` label interpolated with the variable name. Switch the language — labels update without a reload.

### Phase C — Overlays page

1. Add `server/pages/overlays/client/schema.ts` and `client/components/overlay_prop_editor.tsx`.
2. Add `overlays.prop.*` keys to `cs.ts` and `en.ts`.
3. Replace the hand‑written editor in `server/pages/overlays/client/page.tsx` (or the component that rendered it) with `OverlayPropEditor`.
4. Smoke test: select an overlay element, edit text/size/color/font — the preview updates and the overlay runtime receives the new props. Switch the language — labels update.

### Phase D — Dashboards page (optional)

If the dashboards page has its own metadata surface, add `server/pages/dashboards/client/schema.ts` (using `dashboards.meta.*` keys in both catalogues) and swap in `DynamicForm`. If not, skip this phase and document why.

### Phase E — Boundary check

Extend `test/pages_boundaries.test.ts` (or add a companion test) asserting:
1. `shared/ui/components/dynamic_form.tsx` imports only from `shared/ui/`, `shared/i18n/`, and Mithril — no imports from `server/`.
2. `server/modules/overlay_templates/client/*` does not import from `server/pages/*`.
3. `server/pages/overlays/client/*` does not import from `server/modules/*`.
4. **Translation catalogue parity:** every key present in `cs.ts` exists in `en.ts` and vice versa (a straightforward compare of the two default‑exported objects).
5. **No hardcoded UI strings in schemas:** scan `server/modules/overlay_templates/client/schema.ts` and `server/pages/overlays/client/schema.ts` — assert every `FieldSchema` object literal contains a `labelKey` (or `labelParams` for the `overlay_templates.prop.var` case) and no raw `label:` / `help:` strings.

---

## 11. Verification checklist

### Automated

```bash
bun test
bun run build:client
bun run build:server
```

Expected:
- `test/dynamic_form.test.ts` passes (all field types, dotted keys, `visibleWhen`, groups, validation, **label resolution through `t`**, missing‑key fallback).
- `test/pages_boundaries.test.ts` passes (including the new rules in §10 Phase E).
- Both binaries build.

### Manual smoke

1. `bun run dev`, log in.
2. **Dashboards** → open the widget that uses `overlay_templates` → prop editor shows every field from `HtmlTemplateProps`, plus one field per `:root` variable (label `Proměnná {name}` / `Variable {name}`). Editing `bgAlpha`, `fontSize`, `radius`, `padding` updates the preview; switching `mode` to `countdown` reveals `targetIso`.
3. **Overlays** → select an element → the prop editor renders from `overlayElementSchema`; edits propagate to the runtime overlay.
4. **Language switch** — toggle the UI language while a form is open. Labels, help texts, placeholders and select options update immediately; form values are preserved.
5. Save/load round‑trip: values persist to the store unchanged (nested `vars.*` expands correctly).
6. Device bundle: open the device UI — unchanged behaviour, and `DynamicForm` is not required at runtime (verify with the bundle size or a grep).
7. Menu, routing, auth still work — regression check inherited from the refactor.

### “Plug‑a‑field” proof

Add a new `FieldType` (e.g. `"multiselect"`) in a scratch branch:
- Extend `FieldType` and one branch in `renderField`.
- Add the corresponding translation key(s) to `cs.ts` and `en.ts`.
- Add a field to `overlayElementSchema()` using the new type.

Rebuild and confirm the overlays page renders it without touching any other file. Revert.

### “Translate‑only” proof

Change a single `overlay_templates.prop.*` translation in `cs.ts` (e.g. rename `Průhlednost pozadí` → `Neprůhlednost`):
- Rebuild the client.
- Reload the dashboard that uses the HTML‑template widget.
- The label changes; **no code outside `shared/i18n/cs.ts` is touched**. Revert.

---

## 12. Pitfalls and constraints

- **Never store user data through `t`.** Only labels, help texts, placeholders and option labels are translated. Raw values (`props.title`, `widgetConfig.props.*`) are rendered verbatim.
- **Do not pre‑translate schemas.** Schemas must hold `labelKey`s so that a language switch re‑renders without a rebuild. If a schema builder needs dynamic strings (e.g. `Proměnná {name}`), use `labelKey` + `labelParams`, not string concatenation.
- **Both catalogues must move in lockstep.** The boundary test enforces key parity — do not merge a PR that adds `cs.ts` keys without `en.ts`.
- **Do not put `DynamicForm` in `server/ui/`.** It is consumed by widget modules (which live outside `server/pages/`), so `shared/ui/` is the correct home. `server/ui/` remains the page‑only atom repository.
- **Do not import `overlay_schema.ts` from the overlays page.** `HtmlTemplateProps` belongs to the `overlay_templates` module; the overlays page only knows `OverlayElementProps`. If both concepts ever converge, promote a shared type to `shared/contracts/` — not to `server/pages/overlays/shared/`.
- **Do not split `HtmlTemplateProps`.** `overlay_schema.ts` is the single source of truth for `DEFAULT_HTML_TEMPLATE_PROPS`, `parseRootVars`, and `HtmlTemplateProps`. `schemaFromHtmlTemplateProps` derives from it — never duplicates it.
- **Dotted keys must round‑trip.** `setPath` / `getPath` in `dynamic_form.tsx` are the only place that mutates nested state. `coerceHtmlProps` is the only place that converts back to the nested `HtmlTemplateProps` shape.
- **Snake_case file names.** Follow the repo convention: `dynamic_form.tsx`, `overlay_prop_editor.tsx`, `overlay_schema.ts`.
- **Do not touch `shared/registry.ts` or `scripts/gen_modules.ts`.** The widget module contract (`shared/contracts/frontend_module.ts`) is unchanged; `overlay_templates/frontend.tsx` keeps the same exports.
- **Do not touch `server/core/registry.ts` or `scripts/gen_pages.ts`.** `DynamicForm` is a UI atom, not a page.
- **`t` is injectable for tests.** `DynamicForm` accepts a `t` override; production code always relies on the shared `t`. Never instantiate a second translation system.
- **Missing‑key fallback.** `resolve()` returns the raw key and logs once in dev — never an empty label. This makes missing keys obvious in QA without breaking the UI.
- **Conditional visibility.** `visibleWhen` is evaluated on the current `value` at render time. Hidden fields still appear in `onChange` state — prune them in `coerceHtmlProps` if they’re irrelevant, but never silently drop keys the caller set.
- **Bundle hygiene.** Import `DynamicForm` from a deep path (`shared/ui/components/dynamic_form`) inside module client code if the barrel export pulls in too much for the device bundle.

---

## 13. Deliverables

A pull request containing:
1. `shared/ui/components/dynamic_form.tsx` — the library (`FieldSchema` with `labelKey` / `labelParams`, `GroupSchema.legendKey`, `FieldType`, `DynamicForm`, `setPath` / `getPath`, `resolve`).
2. `shared/ui/ui.tsx` — barrel export.
3. `shared/i18n/cs.ts` and `shared/i18n/en.ts` — new `dynamic_form.*`, `overlay_templates.prop.*`, `overlays.prop.*` (and optionally `dashboards.meta.*`) keys, in sync.
4. `test/dynamic_form.test.ts` — unit tests including label resolution and missing‑key fallback.
5. `server/modules/overlay_templates/client/schema.ts` and `client/prop_editor.tsx`.
6. Updated `server/modules/overlay_templates/frontend.tsx` wiring `OverlayTemplatePropEditor`.
7. `server/pages/overlays/client/schema.ts` and `client/components/overlay_prop_editor.tsx`.
8. Updated overlay editor JSX to render `OverlayPropEditor`.
9. `test/pages_boundaries.test.ts` extended with the five rules in §10 Phase E (import directions + translation catalogue parity + no hardcoded labels in schemas).
10. Optionally, `server/pages/dashboards/client/schema.ts` if the page has a metadata surface.
11. A short `DYNAMIC_FORM.md` (or PR description) listing:
    - the placement rationale (`shared/ui/` vs `server/ui/`),
    - the translation strategy (§3) — keys, `labelParams`, parity rule,
    - the mapping from the pre‑refactor editor code to the new files,
    - the “plug‑a‑field” and “translate‑only” proof commands,
    - verification results.

**Definition of done:** `bun test` green (including the new tests and catalogue parity), both binaries build, both the overlays page and the `overlay_templates` widget editor render from `DynamicForm` with full parity to pre‑refactor behaviour — with **every label resolved through `t`**, switching language live without a reload — and adding a new field type or a new translation requires edits only inside the library + caller’s schema + `shared/i18n/`.
