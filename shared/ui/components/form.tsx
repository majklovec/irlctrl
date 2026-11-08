/** @jsx m */
/* Form building blocks: labelled fields, grouped rows and the two-way
 * bound controls (`Input` / `Select` / `Checkbox` write straight into a state
 * object). */
import m from "mithril";
import { t } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";
import type { Child } from "../util";

/** A <label> with a caption above its control; extra attrs (`class`, `hidden`, …) pass through.
 * `required` marks the caption with a red asterisk; `invalid` flags the row as failed validation. */
export const Field = {
	view: ({
		attrs: { label, control, required, invalid, class: extraClass, ...extra },
	}) => (
		// biome-ignore lint/a11y/noLabelWithoutControl: <explanation>
		<label
			{...extra}
			class={
				[extraClass, required ? "f-required" : "", invalid ? "f-invalid" : ""]
					.filter(Boolean)
					.join(" ") || undefined
			}
		>
			<span class="f-caption">
				{label}
				{required ? <b class="f-req"> *</b> : null}
			</span>
			{control}
		</label>
	),
} as MithrilJSXComponent<
	{
		label: Child;
		control: m.Children;
		required?: boolean;
		invalid?: boolean;
	} & m.Attributes
>;

/** Numeric bound input wrapped in a standard form Field label/control row. */
export const NumberField = {
	view: ({
		attrs: { label, target, prop, min, max, placeholder, step, ...fieldAttrs },
	}) => (
		<Field
			{...fieldAttrs}
			label={label}
			control={
				target ? (
					<Input
						target={target}
						prop={prop}
						{...numberAttrs(min, max, placeholder, step)}
					/>
				) : null
			}
		/>
	),
} as MithrilJSXComponent<
	{
		label: Child;
		target?: object;
		prop: string;
		min: number;
		max: number;
		placeholder?: string;
		step?: number;
	} & m.Attributes
>;

/** A checkbox (or radios) with its caption after it. */
export const CheckField = {
	view: ({ attrs: { label, control, class: extraClass, ...extra } }) => (
		// biome-ignore lint/a11y/noLabelWithoutControl: <explanation>
		<label {...extra} class={extraClass ? `${extraClass} check` : "check"}>
			{control}
			{label}
		</label>
	),
} as MithrilJSXComponent<
	{ label: Child; control: m.Children; class?: string } & m.Attributes
>;

/** Line break inside a flex-wrapped form. */
export const Break = {
	view: (_v) => <div class="break" />,
} as MithrilJSXComponent<{ children?: m.Children }>;

/** Titled full-width group of related form fields (<fieldset> + <legend>). */
export const FieldGroup = {
	view: ({ attrs: { legend }, children }) => (
		<fieldset class="group">
			<legend>{legend}</legend>
			{children}
		</fieldset>
	),
} as MithrilJSXComponent<{ legend: Child }>;

/** <option>s from [value, label] pairs. */
export const Options = {
	view: ({ attrs: { pairs } }) =>
		pairs.map(([value, label]) => (
			<option key={value} value={value}>
				{label}
			</option>
		)),
} as MithrilJSXComponent<{ pairs: readonly (readonly [string, string])[] }>;

/** <form> whose submit runs `onSubmit` instead of navigating. */
export const Form = {
	view: ({ attrs: { onSubmit, ...rest }, children }) => (
		<form
			{...rest}
			onsubmit={(e: Event) => {
				e.preventDefault();
				onSubmit?.();
			}}
		>
			{children}
		</form>
	),
} as MithrilJSXComponent<{ onSubmit?: () => void } & m.Attributes>;

// -- Controls two-way bound to a property of a state object ------------------------

/** Keys of `T` whose values are `V`. */
export type KeysOf<T, V> = {
	[K in keyof T]-?: T[K] extends V ? K : never;
}[keyof T] &
	string;

/** Shared props for the bound controls below. `prop` names a property on `target`. */
export interface BoundProps {
	target: object;
	prop: string;
}

/** <input> bound to the string `target[prop]`; `name` defaults to `prop`. */
export const Input = {
	view: ({ attrs: { target, prop, onChange, ...rest } }) => {
		const state = target as Record<string, unknown>;
		return (
			<input
				name={prop}
				{...rest}
				value={state[prop] as string}
				oninput={(e: Event) => {
					const value = (e.target as HTMLInputElement).value;
					state[prop] = value;
					onChange?.(value);
				}}
			/>
		);
	},
} as MithrilJSXComponent<
	BoundProps & { onChange?: (value: string) => void } & m.Attributes
>;

/** <select> bound to the string `target[prop]`. */
export const Select = {
	view: ({ attrs: { target, prop, onChange, ...rest }, children }) => {
		const state = target as Record<string, unknown>;
		return (
			<select
				name={prop}
				{...rest}
				value={state[prop] as string}
				onchange={(e: Event) => {
					const value = (e.target as HTMLSelectElement).value;
					state[prop] = value;
					onChange?.(value);
				}}
			>
				{children}
			</select>
		);
	},
} as MithrilJSXComponent<
	BoundProps & { onChange?: (value: string) => void } & m.Attributes
>;

/** Checkbox bound to the boolean `target[prop]`. */
export const Checkbox = {
	view: ({ attrs: { target, prop, onChange, ...rest } }) => {
		const state = target as Record<string, unknown>;
		return (
			<input
				type="checkbox"
				name={prop}
				{...rest}
				checked={state[prop] as boolean}
				onchange={(e: Event) => {
					const checked = (e.target as HTMLInputElement).checked;
					state[prop] = checked;
					onChange?.(checked);
				}}
			/>
		);
	},
} as MithrilJSXComponent<
	BoundProps & { onChange?: (checked: boolean) => void } & m.Attributes
>;

/** Attributes of a numeric <input>. (Plain function — it returns attrs, not a vnode.) */
export const numberAttrs = (
	min: number,
	max: number,
	placeholder?: string,
	step?: number,
): m.Attributes => ({
	type: "number",
	min,
	max,
	step,
	placeholder,
});
