/** @jsx m */
/* Modal shell: a scrim and a centred card. The confirm dialog builds on it;
 * pages may use it for their own dialogs. `onClose` fires for the backdrop
 * click and Escape. */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";

export const Modal = {
	view: ({ attrs: { title, onClose, class: cls, ...rest }, children }) => (
		<div
			class="modal-backdrop"
			onclick={(e: MouseEvent) => {
				if (e.target === e.currentTarget) onClose?.();
			}}
			onkeydown={(e: KeyboardEvent) => {
				if (e.key === "Escape") onClose?.();
			}}
		>
			<div
				class={["modal", cls ?? ""].filter(Boolean).join(" ")}
				role="dialog"
				aria-modal="true"
				{...rest}
			>
				{title ? <h2 class="modal-title">{title}</h2> : null}
				{children}
			</div>
		</div>
	),
} as MithrilJSXComponent<
	{ title?: m.Children; onClose?: () => void; class?: string } & m.Attributes
>;
