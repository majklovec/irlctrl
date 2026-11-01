/** @jsx m */
/* Transient page notice pinned to the bottom of the viewport. `useToast()`
 * gives a page one toast slot with show / sticky / auto-hide semantics. */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";

export const Toast = {
	view: ({ attrs: { message } }) =>
		message ? <div class="dash-toast">{message}</div> : null,
} as MithrilJSXComponent<{ message?: m.Children }>;

export interface ToastSlot {
	readonly message: string | undefined;
	/** Show `message`; it hides after a few seconds unless `sticky`. */
	show(message: string, sticky?: boolean): void;
	hide(): void;
}

const AUTO_HIDE_MS = 4_000;

export function useToast(): ToastSlot {
	let timer: number | null = null;
	const slot = {
		message: undefined as string | undefined,
		show(message: string, sticky = false) {
			slot.message = message;
			m.redraw();
			if (timer !== null) window.clearTimeout(timer);
			if (!sticky)
				timer = window.setTimeout(() => {
					slot.message = undefined;
					m.redraw();
				}, AUTO_HIDE_MS);
		},
		hide() {
			slot.message = undefined;
			m.redraw();
		},
	};
	return slot;
}
