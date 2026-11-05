import { IconButton, Modal } from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import m from "mithril";
import {
	copyRuntimeUrl,
	runtimeUrl,
	state,
} from "../overlay_store";

/** Focus the copy button once the modal is in the DOM. `oncreate` on the
 * IconButton delivers the button element itself as `dom`. */
const focusCopy = ({ dom }: m.VnodeDOM): void =>
	(dom as HTMLButtonElement).focus();

/** Runtime URL dialog: opened from the toolbar icon, shows the
 * owner-token-authenticated URL (the OBS source) with copy.
 * Only call it while `state.runtimeDialogOpen` and an overlay is loaded. */
export function runtimeDialog(): m.Vnode {
	const id = state.selectedOverlayId;
	return (
		<Modal
			title={t("overlay.runtime_url")}
			onClose={() => (state.runtimeDialogOpen = false)}
		>
			{id ? (
				<div class="ov-runtime">
					<code class="ov-url" title={runtimeUrl(id)}>
						{runtimeUrl(id)}
					</code>
					<IconButton
						class={state.copied ? "ov-copied" : undefined}
						label={state.copied ? t("overlay.copied") : t("overlay.copy")}
						icon={<Icon name="copy" class="role-icon" />}
						oncreate={focusCopy}
						onclick={() => void copyRuntimeUrl(id)}
					/>
				</div>
			) : null}
		</Modal>
	);
}
