/** @jsx m */
/*
 * Shared inspector building blocks. Every element's `editForm` composes its
 * type-specific fields out of `bindField`, so all elements share one look and
 * one binding affordance. While unbound, a field shows its normal control plus
 * a compact **bind select** on the right (a chain icon next to a dropdown; pick
 * a variable to bind). While bound, the control is replaced by a **pill** —
 * the linked variable by name, switchable inline, with an ✕ to detach. (Element
 * *content* lives in the per-element modules; nothing here is specific to a
 * single element type.)
 */
import m from "mithril";
import type { Vnode, VnodeDOM } from "mithril";
import type { Variable } from "../../overlay";
import { t } from "../i18n";
import { Icon } from "../components/icons";
import type { ElementProps, OverlayElement } from "./element";

export function lbl(label: string): Vnode {
	return <span class="ov-lbl">{label}</span>;
}

/** The unbound bind affordance: a chain icon beside a native select. The
 * select's empty value *is* the "not bound" state, so there is no open/closed
 * state to manage. With no variables defined it carries a single "No
 * variables" option (nothing to bind to). */
function bindSelect(
	variables: Variable[],
	onpick: (id: string) => void,
): Vnode {
	if (variables.length === 0)
		return (
			<span class="ov-bind">
				<span class="ov-icon" aria-hidden="true">
					<Icon name="link" />
				</span>
				<select class="ov-bind-sel" disabled value="">
					<option value="">{t("overlay.no_variables")}</option>
				</select>
			</span>
		);
	return (
		<span class="ov-bind">
			<span class="ov-icon" aria-hidden="true">
				<Icon name="link" />
			</span>
			<select
				class="ov-bind-sel"
				value=""
				aria-label={t("overlay.bind_variable")}
				onchange={(ev: Event) => {
					const id = (ev.target as HTMLSelectElement).value;
					if (id) onpick(id);
				}}
			>
				<option value="" disabled hidden>
					{t("overlay.bind_variable")}
				</option>
				{variables.map((v) => (
					<option key={v.id} value={v.id}>
						{v.name}
					</option>
				))}
			</select>
		</span>
	);
}

/** A field bound to a variable: a compact pill — a chain icon, the linked
 * variable's name, a switcher that changes it in place, and an ✕ to detach.
 * Rendering it in place of the field's normal control makes the binding
 * obvious at a glance. */
function boundPill(
	variables: Variable[],
	variableId: string,
	onpick: (id: string) => void,
): Vnode {
	return (
		<span class="ov-bound">
			<span class="ov-icon" aria-hidden="true">
				<Icon name="link" />
			</span>
			<select
				class="ov-var-pick"
				value={variableId}
				aria-label={t("overlay.bind_variable")}
				onchange={(ev: Event) => {
					const id = (ev.target as HTMLSelectElement).value;
					if (id) onpick(id);
				}}
			>
				{variables.map((v) => (
					<option key={v.id} value={v.id}>
						{v.name}
					</option>
				))}
			</select>
			<button
				class="ov-unbind"
				type="button"
				label={t("overlay.unbind_variable")}
				onclick={() => onpick("")}
			>
				<Icon name="close" />
			</button>
		</span>
	);
}

/** Selects and checkboxes offer a fixed choice set, so a variable binding
 * has no meaning for them — no toggle is shown and any stored binding is
 * ignored. */
function isBindable(control: Vnode): boolean {
	const dom = control as VnodeDOM;
	if (typeof dom.tag !== "string") return true;
	if (dom.tag === "select") return false;
	if (dom.tag === "input") return (dom.attrs as { type?: string } | null)?.type !== "checkbox";
	return true;
}

/** One inspector field with an inline binding affordance. `title` is the
 * label shown above the control, `path` the full binding key the schema
 * accepts (`props.<name>`, `transform.<field>`, or `visible`) and `input` the
 * field's normal control. Unbound fields render `input` plus a bind select
 * (see `bindSelect`) on the right; bound fields replace `input` with a pill
 * (see `boundPill`) naming the linked variable. The affordance is omitted for
 * selects and checkboxes (see `isBindable`). */
export function bindField(
	e: OverlayElement,
	path: string,
	title: string,
	input: Vnode,
	props: Pick<ElementProps, "mutate" | "variables">,
): Vnode {
	const bindable = isBindable(input);
	const { mutate, variables } = props;
	if (!bindable)
		return (
			<div class="ov-field">
				<span class="ov-lbl">{title}</span>
				{input}
			</div>
		);

	const binding = e.bindings[path];
	const setPick = (id: string) =>
		mutate((el) => {
			if (id) el.bindings[path] = { kind: "variable", variableId: id };
			else delete el.bindings[path];
		});

	return (
		<div class="ov-field">
			<span class="ov-lbl">{title}</span>
			<div class="ov-field-row">
				<div class="ov-field-ctl">
					{binding ? boundPill(variables, binding.variableId, setPick) : input}
				</div>
				{binding ? null : bindSelect(variables, setPick)}
			</div>
		</div>
	);
}
