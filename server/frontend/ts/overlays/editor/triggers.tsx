import { Button, Card } from "@ui/components";
import m from "mithril";
import { t } from "../../../../../shared/ui/i18n";
import { fireTrigger, scene, state } from "../overlay_store";

export function triggersPanel(): m.Vnode {
	const s = scene();
	return (
		<Card title={t("overlay.triggers")} class="ov-bottom">
			<span class="ov-newvar">
				<input
					type="text"
					placeholder={t("overlay.event_name")}
					value={state.triggerName}
					oninput={(ev: Event) =>
						(state.triggerName = (ev.target as HTMLInputElement).value)
					}
				/>
				<Button label={t("overlay.fire")} onclick={() => void fireTrigger()} />
			</span>
			<p class="muted ov-hint">
				{s ? t("overlay.trigger_hint") : t("overlay.trigger_hint_none")}
			</p>
		</Card>
	);
}
