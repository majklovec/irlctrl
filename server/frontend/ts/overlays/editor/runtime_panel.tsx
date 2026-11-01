import m from "mithril";
import { Icon } from "../../../../../shared/ui/components/icons";
import { Button, Card } from "../../../../../shared/ui/components/ui";
import { t } from "../../../../../shared/ui/i18n";
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
					<Button
						label={<Icon name="sync" class="role-icon" />}
						class="icon-link"
						title={t("overlay.rotate")}
						aria-label={t("overlay.rotate")}
						onclick={() => void rotateToken()}
					/>
					{s ? (
						<Button
							label={<Icon name="copy" class="role-icon" />}
							class={state.copied ? "icon-link ov-copied" : "icon-link"}
							title={state.copied ? t("overlay.copied") : t("overlay.copy")}
							aria-label={t("overlay.copy")}
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
