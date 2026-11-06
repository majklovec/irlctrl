/** @jsx m */
/*
 * DynamicForm — a schema-driven form generator.
 *
 * A `FormSchema` is a plain data description of a form (one `FieldSchema` per
 * control, optionally grouped). `DynamicForm` is a *controlled* Mithril
 * component: it takes `value` and emits `onChange(next)`. Nothing in a schema
 * is a display string — every label, help line, placeholder and option label
 * is a translation KEY resolved through the shared `t` at render time, so a
 * language switch re-renders the form without rebuilding the schema.
 *
 * Placement: `shared/ui/` (not `server/ui/`) because both pages AND dashboard
 * widget modules consume it; `server/ui/` is scoped to pages only. Imports are
 * restricted to `shared/ui/components/form.tsx`, `shared/ui/i18n.tsx`,
 * `shared/ui/util.ts` and Mithril — never `server/` — which `pages_boundaries`
 * pins.
 */
import m from "mithril";
import { t as sharedT } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";
import type { Child } from "../util";
import { FieldGroup } from "./form";

// -- Schema ---------------------------------------------------------------------

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
	/** Translation key, resolved through `t` at render time. */
	labelKey: string;
	labelParams?: Record<string, unknown>;
}

export interface FieldSchema {
	type: FieldType;
	/** Dot-path ("a.b") for nested keys; expanded via `getPath` / `setPath`. */
	name: string;
	/** Translation key for the field caption (required). */
	labelKey: string;
	labelParams?: Record<string, unknown>;

	helpKey?: string;
	helpParams?: Record<string, unknown>;

	placeholderKey?: string;
	placeholderParams?: Record<string, unknown>;

	required?: boolean;
	defaultValue?: unknown;
	/** Choices for `select` / `asset`. */
	options?: FieldOption[];

	min?: number;
	max?: number;
	step?: number;

	/** Hide the field while `getState()[field]` differs from `equals`. */
	visibleWhen?: { field: string; equals: unknown };
	/** Return a translation KEY (resolved through `t`), or `null` when valid. */
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

/** A translation function (`key`, named `params`); the shared `t` by default. */
export type Translate = (
	key: string,
	params?: Record<string, unknown>,
) => string;

// -- Dotted-path state helpers ---------------------------------------------------

/** Read a (possibly dotted) key from a plain-object state tree. */
export function getPath(state: Record<string, unknown>, key: string): unknown {
	let cur: unknown = state;
	for (const part of key.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

/** Deep-clone a JSON-ish value (objects, arrays, primitives). */
function cloneValue(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(cloneValue);
	if (v !== null && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>))
			out[k] = cloneValue(val);
		return out;
	}
	return v;
}

/**
 * Return a copy of `state` with the (possibly dotted) `key` set to `value`,
 * creating intermediate objects as needed. The input is never mutated.
 */
export function setPath(
	state: Record<string, unknown>,
	key: string,
	value: unknown,
): Record<string, unknown> {
	const clone = cloneValue(state) as Record<string, unknown>;
	const parts = key.split(".");
	let cur = clone;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		if (typeof cur[part] !== "object" || cur[part] === null) cur[part] = {};
		cur = cur[part] as Record<string, unknown>;
	}
	cur[parts[parts.length - 1]] = value;
	return clone;
}

// -- Translation ----------------------------------------------------------------

const warned = new Set<string>();

/**
 * Resolve a translation key through `t`. A missing key (i18next falls back to
 * the raw key) yields the raw key so the UI never shows an empty label, and it
 * is logged once. User data is NEVER routed through here — only label / help /
 * placeholder / option keys.
 */
export function resolve(
	t: Translate,
	key: string,
	params?: Record<string, unknown>,
): string {
	const out = t(key, params);
	if (!out || out === key) {
		if (!warned.has(key)) {
			warned.add(key);
			console.warn(`[dynamic_form] missing translation: ${key}`);
		}
		return key;
	}
	return out;
}

/**
 * Resolve `labelParams`-style values against the live state: a string that
 * names a path present in `state` is replaced by the value at that path, so
 * `labelParams: { name: "vars.name" }` interpolates the live value. Anything
 * that is not a resolvable path is passed through unchanged (literal).
 */
function resolveParams(
	state: Record<string, unknown>,
	params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (!params) return params;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(params)) {
		if (typeof v === "string") {
			const resolved = getPath(state, v);
			out[k] = resolved !== undefined ? resolved : v;
		} else {
			out[k] = v;
		}
	}
	return out;
}

// -- Component ------------------------------------------------------------------

export interface DynamicFormAttrs {
	schema: FormSchema;
	value: Record<string, unknown>;
	onChange?: (next: Record<string, unknown>) => void;
	onSubmit?: () => void;
	disabled?: boolean;
	/** Translation override (tests); defaults to the shared `t`. */
	t?: Translate;
}

/** HTML value for a `datetime-local` input from an ISO-8601 string. */
const toLocalInput = (iso: unknown): string =>
	typeof iso === "string" && iso ? iso.slice(0, 16) : "";

/** ISO-8601 for a stored value from a `datetime-local` input value. */
const toIso = (local: string): string =>
	local ? new Date(local).toISOString() : "";

const isEmpty = (v: unknown): boolean =>
	v === undefined ||
	v === null ||
	v === "" ||
	(Array.isArray(v) && v.length === 0);

/** Fully-resolved control value for `makeControl`. The caller owns schema /
 * state / i18n semantics: it resolves the current value, pre-resolves option
 * labels to plain strings, and supplies the single write path. This keeps the
 * builder (shared by `DynamicForm` and `overlay/fields.tsx`'s `bindableForm`)
 * free of both. */
export interface ControlValue {
	type: FieldType;
	/** Control identity (html `name`); also the key the control is bound to. */
	name: string;
	/** Already-resolved current value. */
	value: unknown;
	min?: number;
	max?: number;
	step?: number;
	/** Already-resolved option labels (no translation keys). */
	options?: { value: string; label: string }[];
	placeholder?: string;
	disabled?: boolean;
	/** Single write path: receive the control's new value. */
	write: (v: unknown) => void;
}

/** Build the raw control for one field. The ONLY place the per-type
 * `<input>` / `<select>` markup lives — shared by `DynamicForm` and
 * `bindableForm` so the two never drift. */
export function makeControl(c: ControlValue): m.Vnode {
	const { type, name, value, write, min, max, step } = c;
	switch (type) {
		case "text":
			return m("input", {
				type: "text",
				name,
				disabled: c.disabled,
				placeholder: c.placeholder,
				value: (value as string) ?? "",
				oninput: (e: Event) => write((e.target as HTMLInputElement).value),
			});
		case "textarea":
			return m("textarea", {
				name,
				disabled: c.disabled,
				placeholder: c.placeholder,
				value: (value as string) ?? "",
				oninput: (e: Event) =>
					write((e.target as HTMLTextAreaElement).value),
			});
		case "number":
			return m("input", {
				type: "number",
				name,
				disabled: c.disabled,
				placeholder: c.placeholder,
				min,
				max,
				step,
				value: value === undefined ? "" : (value as number),
				oninput: (e: Event) => {
					const n = Number((e.target as HTMLInputElement).value);
					write(Number.isFinite(n) ? n : 0);
				},
			});
		case "range":
			return m("input", {
				type: "range",
				name,
				disabled: c.disabled,
				min: min ?? 0,
				max: max ?? 100,
				step: step ?? 1,
				value: value === undefined ? (min ?? 0) : (value as number),
				oninput: (e: Event) =>
					write(Number((e.target as HTMLInputElement).value)),
			});
		case "select":
		case "asset":
			return m(
				"select",
				{
					name,
					disabled: c.disabled,
					value: (value as string) ?? "",
					onchange: (e: Event) =>
						write((e.target as HTMLSelectElement).value),
				},
				(c.options ?? []).map((opt) =>
					m("option", { key: opt.value, value: opt.value }, opt.label),
				),
			);
		case "checkbox":
			return m("input", {
				type: "checkbox",
				name,
				disabled: c.disabled,
				checked: Boolean(value),
				onchange: (e: Event) =>
					write((e.target as HTMLInputElement).checked),
			});
		case "color":
			return m("input", {
				type: "color",
				name,
				disabled: c.disabled,
				value: (value as string) ?? "#000000",
				// `oninput`, not `onchange`: a color picker emits `input` while
				// dragging — matching every element editor, so the preview
				// updates live instead of only on palette-commit.
				oninput: (e: Event) =>
					write((e.target as HTMLInputElement).value),
			});
		case "iso-datetime":
			return m("input", {
				type: "datetime-local",
				name,
				disabled: c.disabled,
				value: toLocalInput(value),
				onchange: (e: Event) =>
					write(toIso((e.target as HTMLInputElement).value)),
			});
	}
}

/** Build the control for a `FieldSchema`, bound to `getState` /
 * `handleChange` — a thin adapter over the shared `makeControl`. */
function controlFor(
	f: FieldSchema,
	getState: () => Record<string, unknown>,
	handleChange: (name: string, v: unknown) => void,
	disabled: boolean | undefined,
	t: Translate,
	placeholder?: string,
): m.Vnode {
	return makeControl({
		type: f.type,
		name: f.name,
		value: getPath(getState(), f.name),
		min: f.min,
		max: f.max,
		step: f.step,
		options: (f.options ?? []).map((o) => ({
			value: o.value,
			label: resolve(t, o.labelKey, o.labelParams),
		})),
		placeholder,
		disabled,
		write: (v) => handleChange(f.name, v),
	});
}

/** Render one `FieldSchema` as a labelled row (label, control, help, error). */
function renderField(
	f: FieldSchema,
	getState: () => Record<string, unknown>,
	handleChange: (name: string, v: unknown) => void,
	disabled: boolean | undefined,
	t: Translate,
): m.Children {
	if (
		f.visibleWhen &&
		getPath(getState(), f.visibleWhen.field) !== f.visibleWhen.equals
	)
		return null;

	const state = getState();
	const label = resolve(t, f.labelKey, resolveParams(state, f.labelParams));
	const help = f.helpKey
		? resolve(t, f.helpKey, resolveParams(state, f.helpParams))
		: undefined;
	const placeholder = f.placeholderKey
		? resolve(t, f.placeholderKey, resolveParams(state, f.placeholderParams))
		: undefined;

	const value = getPath(state, f.name);
	const rawError =
		f.validate?.(value) ??
		(f.required && isEmpty(value) ? "dynamic_form.required" : null);
	// Validation returns a translation KEY, so route it through `t` like every
	// other label (never show the raw key to the user).
	const error = rawError ? resolve(t, rawError) : null;

	const control = controlFor(
		f,
		getState,
		handleChange,
		disabled,
		t,
		placeholder,
	);

	const caption = m("span", { class: "df-label" }, [
		label,
		f.required ? m("b", { class: "df-req" }, " *") : null,
	]);
	const children: Child[] = [
		caption,
		control,
		help ? m("span", { class: "df-help" }, help) : null,
		error ? m("span", { class: "df-error" }, error) : null,
	];
	return m("label", { class: "df-field" }, children);
}

/**
 * A controlled, schema-driven form. `value` is the full form state; edits
 * emit `onChange(next)` with a new object (dotted names expanded). All labels
 * resolve through `t` (injectable) at render time.
 */
export const DynamicForm = {
	view: ({ attrs }) => {
		const {
			schema,
			value,
			onChange,
			onSubmit,
			disabled,
			t = sharedT,
		} = attrs as DynamicFormAttrs;
		// A live reference to the latest value so `visibleWhen` / validation /
		// option labels read current state during a single render pass.
		let state = value ?? {};
		const getState = () => state;
		const handleChange = (name: string, v: unknown) => {
			state = setPath(state, name, v);
			onChange?.(state);
		};

		return m(
			"form",
			{
				class: "dynamic-form",
				onsubmit: (e: Event) => {
					e.preventDefault();
					onSubmit?.();
				},
			},
			schema.fields.map((f) =>
				(f as GroupSchema).type === "group"
					? m(
							FieldGroup,
							{
								legend: resolve(
									t,
									(f as GroupSchema).legendKey,
									(f as GroupSchema).legendParams,
								),
							},
							(f as GroupSchema).fields.map((child) =>
								renderField(
									child as FieldSchema,
									getState,
									handleChange,
									disabled,
									t,
								),
							),
						)
					: renderField(f as FieldSchema, getState, handleChange, disabled, t),
			),
		);
	},
} as MithrilJSXComponent<DynamicFormAttrs>;
