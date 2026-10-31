/** @jsx m */
/*
 * Shared inspector building blocks. Every element's `editForm` composes its
 * type-specific fields out of these, so all elements share one look and one
 * binding control. (Element *content* lives in the per-element modules;
 * nothing here is specific to a single element type.)
 */
import m from "mithril";
import type { Vnode } from "mithril";
import type { Variable } from "../../../shared/overlay";
import { t } from "../i18n";
import type { ElementProps, OverlayElement } from "./core";

export function lbl(label: string): Vnode {
	return <span class="ov-lbl">{label}</span>;
}

/** A `props.<prop>` → variable binding select. v1 bindings are keyed
 * "props.<name>". Only needs the slice of `ElementProps` it uses. */
export function bindingRow(
	e: OverlayElement,
	prop: string,
	{
		mutate,
		variables,
	}: Pick<ElementProps, "mutate" | "variables">,
): Vnode {
	const key = "props." + prop;
	const binding = e.bindings[key];
	return (
		<label class="ov-field">
			{lbl(t("overlay.binding") + " (" + prop + ")")}
			<select
				value={binding ? binding.variableId : ""}
				onchange={(ev: Event) => {
					const id = (ev.target as HTMLSelectElement).value;
					mutate((el) => {
						if (id) el.bindings[key] = { kind: "variable", variableId: id };
						else delete el.bindings[key];
					});
				}}
			>
				<option value="">{t("overlay.no_binding")}</option>
				{variables.map((v: Variable) => (
					<option key={v.id} value={v.id}>
						{v.name}
					</option>
				))}
			</select>
		</label>
	);
}
