import { Button, Card, IconButton } from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import m from "mithril";
import {
	copyRuntimeUrl,
	rotateToken,
	runtimeUrl,
	scene,
	state,
} from "../overlay_store";

export function runtimePanel(): m.Vnode {
	const s = scene();
	return (
		<Card
			title={t("overlay.runtime_url")}
			class="ov-bottom"
			headActions={
				<>
					<IconButton
						label={t("overlay.rotate")}
						icon={<Icon name="sync" class="role-icon" />}
						onclick={() => void rotateToken()}
					/>
					{s ? (
						<IconButton
							class={state.copied ? "ov-copied" : undefined}
							label={state.copied ? t("overlay.copied") : t("overlay.copy")}
							icon={<Icon name="copy" class="role-icon" />}
							onclick={() => void copyRuntimeUrl(s)}
						/>
					) : null}
				</>
			}
		>
			{s ? (
				<div class="ov-runtime">
					<code class="ov-url">{runtimeUrl(s)}</code>
				</div>
			) : (
				<p class="muted">{t("overlay.no_selection")}</p>
			)}
		</Card>
	);
}
