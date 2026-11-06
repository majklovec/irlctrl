/** @jsx m */
/*
 * Shared inspector building blocks. Every element's `editForm` composes its
 * type-specific fields out of `bindField`, so all elements share one look and
 * one binding affordance. Each bindable control has a small **chain-icon
 * toggle** on its right. Clicking it turns the chain yellow and swaps the
 * control for a variable picker; picking a variable binds the field (the
 * chain stays yellow, marking the field as bound). Clicking the yellow
 * chain again detaches. A bound field additionally offers a **copy-icon
 * button** (when its editor provides a `variableUrl`) that copies the
 * owner-token URL revaluing the bound variable (append a value to its
 * trailing `…&<name>=`). (Element *content* lives in the per-element
 * modules; nothing here is specific to a single element type.)
 */

import type { Vnode, VnodeDOM } from "mithril";
import m from "mithril";
import type { Variable } from "../../../server/pages/overlays/overlay";
import type { FieldType } from "../components/dynamic_form";
import { makeControl } from "../components/dynamic_form";
import { Icon } from "../components/icons";
import { t } from "../i18n";
import type { ElementProps, OverlayElement } from "./element";

/** element id + path of fields whose picker is open. Module scope on
 * purpose: Mithril re-creates per-render closures, so a `view()`-local
 * "open" flag would reset on every redraw and the picker would never
 * stay open. `varCopied` tracks the same way, briefly, which bound fields
 * just copied their variable URL — the copied button flashes green. */
const pickOpen = new Set<string>();
const varCopied = new Set<string>();

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
 * renders as unbound (the stale reference is replaced on the next bind).
 * When the field is bound and `props.variableUrl` is provided, a copy-icon
 * button appears next to the chain and copies the owner-token URL that
 * revalues the bound variable. */
export function bindField(
	e: OverlayElement,
	path: string,
	title: string,
	input: Vnode,
	props: Pick<ElementProps, "mutate" | "variables" | "variableUrl">,
): Vnode {
	if (!isBindable(input))
		return (
			<div class="ov-field">
				<span class="ov-lbl">{title}</span>
				{input}
			</div>
		);

	const { mutate, variables, variableUrl } = props;
	const key = e.id + ":" + path;
	const binding = e.bindings[path];
	const boundVar =
		binding !== undefined
			? variables.find((v) => v.id === binding.variableId)
			: undefined;
	const bound = boundVar !== undefined;
	const open = !bound && pickOpen.has(key);
	const active = bound || open;
	const copied = varCopied.has(key);

	const copyUrl = (): void => {
		if (!boundVar || !variableUrl) return;
		void navigator.clipboard
			.writeText(variableUrl(boundVar.name))
			.then(() => {
				varCopied.add(key);
				m.redraw();
				setTimeout(() => {
					varCopied.delete(key);
					m.redraw();
				}, 1500);
			})
			.catch(() => {
				/* clipboard unavailable — the URL is also available in the variables dialog */
			});
	};

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
				{bound && variableUrl ? (
					<button
						class={copied ? "ov-bind-copy ov-copied" : "ov-bind-copy"}
						type="button"
						title={copied ? t("overlay.copied") : t("overlay.copy_variable_url")}
						aria-label={t("overlay.copy_variable_url")}
						onclick={copyUrl}
					>
						<Icon name="copy" class="role-icon" />
					</button>
				) : null}
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

// ── bindableForm ────────────────────────────────────────────────────────
// A form-shaped descriptor → a fully-wired inspector form. Each data field
// is built into its raw control and wrapped in `bindField`, so the variable
// binding affordance is applied exactly where `isBindable` allows (chain
// toggle on text/number/color; never on select/checkbox). A row of field
// descriptors renders in an `ov-grid<N>`; a raw Vnode row is the escape
// hatch for custom widgets (rendered verbatim, no binding).

/** Control types `bindableForm` knows how to build — the full `makeControl`
 * vocabulary (text/textarea/number/range/select/checkbox/color/asset/
 * iso-datetime), so every DynamicForm control type is directly usable. */
export type FormFieldType = FieldType;

/** One choice of a `select` field. */
export interface FormFieldOption {
	value: string;
	/** Display text (already translated by the caller). */
	label: string;
}

/** One data-driven inspector field.
 * `path` is the full binding key the schema accepts (`props.<name>`); the
 * written prop is `path` with the `props.` prefix stripped (the convention
 * every per-element `editForm` uses). `value` is the *already-resolved*
 * current value — the caller reads it with `strProp`/`numProp`. */
export interface FormField {
	path: string;
	/** i18n label key, resolved through `t` at render time. Mutually
	 * exclusive with `label` (supply one or the other, `label` wins). */
	labelKey?: string;
	/** Pre-resolved label text — use when there is no i18n key (e.g. the
	 * html_template's bespoke text slots, labelled from the slot name). */
	label?: string;
	type: FormFieldType;
	value: unknown;
	/** Bounds for a `number` field. */
	min?: number;
	max?: number;
	step?: number;
	/** Choices for a `select` field. */
	options?: FormFieldOption[];
}

/** One form row: a group of fields (laid out in a grid) or a raw Vnode
 * rendered verbatim (custom widget — never bound). */
export type FormRow = FormField[] | Vnode;

/** The raw control for one field, wired to write its prop on change.
 * Delegates the per-type `<input>` / `<select>` markup to the shared
 * `makeControl` (also used by `DynamicForm`) so the two never drift; this
 * only supplies the binding write path. */
function controlFor(f: FormField, mutate: ElementProps["mutate"]): Vnode {
	const key = f.path.startsWith("props.")
		? f.path.slice("props.".length)
		: f.path;
	return makeControl({
		type: f.type,
		name: key,
		value: f.value,
		min: f.min,
		max: f.max,
		step: f.step,
		options: f.options,
		write: (v) => mutate((el) => void (el.props[key] = v)),
	});
}

/** The field's display label: a pre-resolved `label` wins, else the
 * `labelKey` through `t` (an empty string if neither is set). */
function fieldLabel(f: FormField): string {
	return f.label ?? (f.labelKey !== undefined ? t(f.labelKey) : "");
}

/** Bind + group one row of fields into its grid (or a bare field). */
function rowFields(
	fields: FormField[],
	e: OverlayElement,
	sp: Pick<ElementProps, "mutate" | "variables" | "variableUrl">,
): Vnode {
	const bound = fields.map((f) =>
		bindField(e, f.path, fieldLabel(f), controlFor(f, sp.mutate), sp),
	);
	if (bound.length === 1) return bound[0];
	return <div class={bound.length === 2 ? "ov-grid2" : "ov-grid3"}>{bound}</div>;
}

/** Render a form-shaped descriptor as an inspector form. See `FormRow` for
 * the row contract; every data field is wrapped in `bindField`, so binding
 * is applied where `isBindable` allows and the chain toggle + picker + copy
 * button behave exactly like the per-element `editForm`s. Returns a
 * fragment, the same shape an `editForm` returns today. */
export function bindableForm(attrs: {
	element: OverlayElement;
	mutate: ElementProps["mutate"];
	variables: ElementProps["variables"];
	variableUrl?: ElementProps["variableUrl"];
	rows: FormRow[];
}): Vnode {
	const { element, mutate, variables, variableUrl, rows } = attrs;
	const sp = { mutate, variables, variableUrl };
	const out: Vnode[] = [];
	for (const row of rows) {
		if (typeof row === "object" && Array.isArray(row))
			out.push(rowFields(row, element, sp));
		else out.push(row);
	}
	return <>{out}</>;
}
