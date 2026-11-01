/** @jsx m */
/* The "nothing here yet" block of a list: a muted message and, usually,
 * the toolbar that creates the first item. */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";

export const EmptyState = {
	view: ({ attrs: { message }, children }) => (
		<div class="dash-empty">
			<p class="muted">{message}</p>
			{children}
		</div>
	),
} as MithrilJSXComponent<{ message: m.Children }>;
