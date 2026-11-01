/** @jsx m */
/*
 * Confirmation dialog — the app's replacement for `window.confirm`: a modal
 * with the message and two buttons, resolved as a promise. Mounted on its
 * own root so it can be awaited from any handler; Escape / the backdrop
 * cancel, Enter confirms.
 */
import m from "mithril";
import { t } from "../i18n";
import { Button } from "./ui";

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

const Dialog: m.Component = {
	oncreate: ({ dom }) => {
		(dom.querySelector("button[data-ok]") as HTMLButtonElement | null)?.focus();
	},
	view: () =>
		pending && (
			<div
				class="modal-backdrop"
				onclick={(e: MouseEvent) => {
					if (e.target === e.currentTarget) close(false);
				}}
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === "Escape") close(false);
					if (e.key === "Enter") close(true);
				}}
			>
				<div class="modal" role="dialog" aria-modal="true">
					{pending.title ? <h2 class="modal-title">{pending.title}</h2> : null}
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
				</div>
			</div>
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
