/** @jsx m */
/*
 * Shared inspector building blocks. Every element's `editForm` composes its
 * type-specific fields out of `bindField`, so all elements share one look
 * and one binding affordance: a tiny label-less checkbox next to each field
 * (info on hover); checked, the field's control swaps to a variable picker.
 * (Element *content* lives in the per-element modules; nothing here is
 * specific to a single element type.)
 */
import m from "mithril";
import type { Vnode } from "mithril";
import type { Variable } from "../../../shared/overlay";
import { t } from "../i18n";
import type { ElementProps, OverlayElement } from "./core";

export function lbl(label: string): Vnode {
	return <span class="ov-lbl">{label}</span>;
}

/** The small, label-less binding checkbox (its `title` tooltip is the only
 * visible info). Checking binds `path` to the first variable, unchecking
 * removes the binding; without a single variable the toggle stays disabled
 * so no half-set binding is ever stored. */
export function bindToggle(
	e: OverlayElement,
	path: string,
	{
		mutate,
		variables,
	}: Pick<ElementProps, "mutate" | "variables">,
): Vnode {
	return (
		<input
			type="checkbox"
			class="ov-bind-chk"
			title={t("overlay.bind_variable")}
			aria-label={t("overlay.bind_variable")}
			checked={e.bindings[path] !== undefined}
			disabled={e.bindings[path] === undefined && variables.length === 0}
			onchange={(ev: Event) =>
				mutate((el) => {
					if ((ev.target as HTMLInputElement).checked) {
						const first = variables[0];
						if (first)
							el.bindings[path] = { kind: "variable", variableId: first.id };
					} else {
						delete el.bindings[path];
					}
				})
			}
		/>
	);
}

/** Variable picker shown in place of a field's normal control while the
 * field is bound. */
function varSelect(
	e: OverlayElement,
	path: string,
	variables: Variable[],
	{ mutate }: Pick<ElementProps, "mutate">,
): Vnode {
	const binding = e.bindings[path];
	return (
		<select
			class="ov-var-sel"
			value={binding ? binding.variableId : ""}
			onchange={(ev: Event) => {
				const id = (ev.target as HTMLSelectElement).value;
				mutate((el) => {
					if (id)
						el.bindings[path] = { kind: "variable", variableId: id };
					else delete el.bindings[path];
				});
			}}
		>
			{variables.map((v: Variable) => (
				<option key={v.id} value={v.id}>
					{v.name}
				</option>
			))}
		</select>
	);
}

/** One inspector field with an inline binding toggle. `title` is the label
 * shown above the control, `path` the full binding key the schema accepts
 * (`props.<name>`, `transform.<field>`, or `visible`) and `input` the
 * field's normal control. While the small, label-less checkbox on the right
 * (see `bindToggle`) is checked, `input` is replaced by a select over the
 * project variables. */
export function bindField(
	e: OverlayElement,
	path: string,
	title: string,
	input: Vnode,
	props: Pick<ElementProps, "mutate" | "variables">,
): Vnode {
	const bound = e.bindings[path] !== undefined;
	return (
		<div class="ov-field">
			<span class="ov-lbl">{title}</span>
			<div class="ov-field-row">
				<div class="ov-field-ctl">
					{bound ? varSelect(e, path, props.variables, { mutate: props.mutate }) : input}
				</div>
				{bindToggle(e, path, props)}
			</div>
		</div>
	);
}
