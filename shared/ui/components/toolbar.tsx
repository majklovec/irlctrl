/** @jsx m */
/* A row of controls with an optional leading label — the create bar under
 * entity lists, the editor's icon strip. */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";

export const Toolbar = {
	view: ({ attrs: { label, class: cls, ...rest }, children }) => (
		<div
			class={["dash-toolbar", cls ?? ""].filter(Boolean).join(" ")}
			role="toolbar"
			{...rest}
		>
			{label ? <span class="dash-empty-text">{label}</span> : null}
			{children}
		</div>
	),
} as MithrilJSXComponent<{ label?: m.Children; class?: string } & m.Attributes>;
