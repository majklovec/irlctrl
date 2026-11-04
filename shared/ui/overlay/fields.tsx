/** @jsx m */
/*
 * Shared inspector building blocks. Every element's `editForm` composes its
 * type-specific fields out of `bindField`, so all elements share one look and
 * one binding affordance. Each bindable control has a small **chain-icon
 * toggle** on its right. Clicking it turns the chain yellow and swaps the
 * control for a variable picker; picking a variable binds the field (the
 * chain stays yellow, marking the field as bound). Clicking the yellow
 * chain again detaches. (Element *content* lives in the per-element
 * modules; nothing here is specific to a single element type.)
 */

import type { Vnode, VnodeDOM } from "mithril";
import m from "mithril";
import type { Variable } from "../../../server/pages/overlays/overlay";
import { Icon } from "../components/icons";
import { t } from "../i18n";
import type { ElementProps, OverlayElement } from "./element";

/** element id + path of fields whose picker is open. Module scope on
 * purpose: Mithril re-creates per-render closures, so a `view()`-local
 * "open" flag would reset on every redraw and the picker would never
 * stay open. */
const pickOpen = new Set<string>();

export function lbl(label: string): Vnode {
	return <span class="ov-lbl">{label}</span>;
}

/** Selects and checkboxes offer a fixed choice set, so a variable binding
 * has no meaning for them — no toggle is shown and any stored binding is
 * ignored. */
function isBindable(control: Vnode): boolean {
	const dom = control as VnodeDOM;
	if (typeof dom.tag !== "string") return true;
	if (dom.tag === "select") return false;
	if (dom.tag === "input")
		return (dom.attrs as { type?: string } | null)?.type !== "checkbox";
	return true;
}

/** One inspector field with the chain-icon binding toggle. `title` is the
 * label shown above the control, `path` the full binding key the schema
 * accepts (`props.<name>`, `transform.<field>`, or `visible`) and `input`
 * the field's normal control. While the picker is open — or the field is
 * bound — the control is replaced by a `select` of the project's variables
 * and the chain stays yellow. A binding to a since-deleted variable
 * renders as unbound (the stale reference is replaced on the next bind). */
export function bindField(
	e: OverlayElement,
	path: string,
	title: string,
	input: Vnode,
	props: Pick<ElementProps, "mutate" | "variables">,
): Vnode {
	if (!isBindable(input))
		return (
			<div class="ov-field">
				<span class="ov-lbl">{title}</span>
				{input}
			</div>
		);

	const { mutate, variables } = props;
	const key = e.id + ":" + path;
	const binding = e.bindings[path];
	const bound =
		binding !== undefined && variables.some((v) => v.id === binding.variableId);
	const open = !bound && pickOpen.has(key);
	const active = bound || open;

	const setPick = (id: string): void => {
		pickOpen.delete(key);
		if (id)
			mutate((el) => {
				el.bindings[path] = { kind: "variable", variableId: id };
			});
		else m.redraw();
	};

	const toggle = (): void => {
		if (bound) {
			pickOpen.delete(key);
			mutate((el) => {
				delete el.bindings[path];
			});
		} else if (open) {
			pickOpen.delete(key);
			m.redraw();
		} else {
			pickOpen.add(key);
			m.redraw();
		}
	};

	const picker = (
		<select
			class="ov-var-sel"
			value={bound ? (binding?.variableId ?? "") : ""}
			aria-label={t("overlay.bind_variable")}
			onchange={(ev: Event) => setPick((ev.target as HTMLSelectElement).value)}
		>
			{variables.length === 0 ? (
				<option value="" disabled>
					{t("overlay.no_variables")}
				</option>
			) : (
				<>
					<option value="" disabled hidden>
						{t("overlay.bind_variable")}
					</option>
					{variables.map((v) => (
						<option key={v.id} value={v.id}>
							{v.name}
						</option>
					))}
				</>
			)}
		</select>
	);

	return (
		<div class="ov-field">
			<span class="ov-lbl">{title}</span>
			<div class="ov-field-row">
				<div class="ov-field-ctl">{active ? picker : input}</div>
				<button
					class={active ? "ov-bind-chk on" : "ov-bind-chk"}
					type="button"
					title={
						bound ? t("overlay.unbind_variable") : t("overlay.bind_variable")
					}
					aria-label={
						bound ? t("overlay.unbind_variable") : t("overlay.bind_variable")
					}
					aria-pressed={bound}
					onclick={toggle}
				>
					<Icon name="link" class="role-icon" />
				</button>
			</div>
		</div>
	);
}
