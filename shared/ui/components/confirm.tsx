/** @jsx m */
/*
 * Confirmation dialog — the app's replacement for `window.confirm`: a modal
 * with the message and two buttons, resolved as a promise. Mounted on its
 * own root so it can be awaited from any handler; Escape / the backdrop
 * cancel, Enter confirms.
 */
import m from "mithril";
import { t } from "../i18n";
import { Button } from "./button";
import { Modal } from "./modal";

export interface ConfirmOptions {
	/** Label of the confirming button (default: the "OK" wording). */
	okLabel?: string;
	/** Style the confirming button as destructive. */
	danger?: boolean;
	title?: string;
}

interface Pending extends ConfirmOptions {
	message: string;
	resolve: (ok: boolean) => void;
}

let pending: Pending | null = null;
let root: HTMLElement | null = null;

function close(ok: boolean): void {
	const p = pending;
	pending = null;
	m.redraw();
	p?.resolve(ok);
}

/** Focus the confirming button once the modal is in the DOM. */
const focusOk = ({ dom }: m.VnodeDOM) =>
	(dom.querySelector("button[data-ok]") as HTMLButtonElement | null)?.focus();

const Dialog: m.Component = {
	view: () =>
		pending && (
			<Modal
				title={pending.title}
				onClose={() => close(false)}
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === "Enter") close(true);
				}}
				oncreate={focusOk}
			>
				<p class="modal-body">{pending.message}</p>
				<div class="actions modal-actions">
					<Button
						label={t("ui.cancel")}
						class="secondary"
						onclick={() => close(false)}
					/>
					<Button
						label={pending.okLabel ?? t("ui.ok")}
						class={pending.danger ? "danger" : undefined}
						data-ok="1"
						onclick={() => close(true)}
					/>
				</div>
			</Modal>
		),
};

/** Ask the user to confirm; resolves `true` on confirm. One dialog at a
 * time — a second call while one is open cancels the first. */
export function confirmDialog(
	message: string,
	options: ConfirmOptions = {},
): Promise<boolean> {
	if (!root) {
		root = document.createElement("div");
		root.className = "modal-root";
		document.body.appendChild(root);
		m.mount(root, Dialog);
	}
	pending?.resolve(false);
	return new Promise((resolve) => {
		pending = { message, resolve, ...options };
		m.redraw();
	});
}
