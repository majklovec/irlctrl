import { IconButton, Modal } from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import m from "mithril";
import {
	copyRuntimeUrl,
	overlay,
	rotateToken,
	runtimeUrl,
	state,
} from "../overlay_store";

/** Focus the copy button once the modal is in the DOM. `oncreate` on the
 * IconButton delivers the button element itself as `dom`. */
const focusCopy = ({ dom }: m.VnodeDOM): void =>
	(dom as HTMLButtonElement).focus();

/** Runtime URL dialog: opened from the toolbar icon, shows the
 * token-authenticated URL (the OBS source) with copy + token-rotate.
 * Only call it while `state.runtimeDialogOpen` and an overlay exists. */
export function runtimeDialog(): m.Vnode {
	const s = overlay();
	const ref =
		s && state.selectedOverlayId
			? { id: state.selectedOverlayId, token: state.token }
			: null;
	return (
		<Modal
			title={t("overlay.runtime_url")}
			onClose={() => (state.runtimeDialogOpen = false)}
		>
			{ref ? (
				<div class="ov-runtime">
					<code class="ov-url" title={runtimeUrl(ref)}>
						{runtimeUrl(ref)}
					</code>
					<IconButton
						class={state.copied ? "ov-copied" : undefined}
						label={state.copied ? t("overlay.copied") : t("overlay.copy")}
						icon={<Icon name="copy" class="role-icon" />}
						oncreate={focusCopy}
						onclick={() => void copyRuntimeUrl(ref)}
					/>
					<IconButton
						label={t("overlay.rotate")}
						icon={<Icon name="sync" class="role-icon" />}
						onclick={() => void rotateToken()}
					/>
				</div>
			) : null}
		</Modal>
	);
}
