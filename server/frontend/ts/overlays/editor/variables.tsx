import m from "mithril";
import { Icon } from "../../../../../shared/ui/components/icons";
import { Button, Card } from "../../../../../shared/ui/components/ui";
import { t } from "../../../../../shared/ui/i18n";
import {
	copyVariableUrl,
	createVariable,
	deleteVariable,
	setVariable,
	state,
} from "../overlay_store";

export function variablesPanel(): m.Vnode {
	return (
		<Card
			title={t("overlay.variables")}
			class="ov-bottom"
			headActions={
				<span class="ov-newvar">
					<input
						type="text"
						placeholder={t("overlay.variable_name")}
						value={state.newVariableName}
						oninput={(ev: Event) =>
							(state.newVariableName = (ev.target as HTMLInputElement).value)
						}
					/>
					<select
						value={state.newVariableType}
						onchange={(ev: Event) =>
							(state.newVariableType = (ev.target as HTMLSelectElement).value)
						}
					>
						<option value="string">string</option>
						<option value="number">number</option>
						<option value="boolean">boolean</option>
						<option value="color">color</option>
					</select>
					<Button
						label={t("overlay.add")}
						onclick={() => void createVariable()}
					/>
				</span>
			}
		>
			<div class="ov-var-list">
				{state.project.variables.length === 0 ? (
					<p class="muted">{t("overlay.no_variables")}</p>
				) : (
					state.project.variables.map((v) => (
						<div key={v.id} class="ov-var">
							<span class="ov-var-name" title={v.name}>
								{v.name}
							</span>
							<button
								type="button"
								class={
									state.copiedVariableId === v.id
										? "ov-var-copy ov-copied"
										: "ov-var-copy"
								}
								title={
									state.copiedVariableId === v.id
										? t("overlay.copied")
										: t("overlay.copy_variable_url")
								}
								aria-label={t("overlay.copy_variable_url")}
								onclick={() => void copyVariableUrl(v.id)}
							>
								<Icon name="copy" class="role-icon" />
							</button>
							{v.type === "boolean" ? (
								<input
									type="checkbox"
									checked={Boolean(v.value)}
									onchange={(ev: Event) =>
										void setVariable(
											v.id,
											(ev.target as HTMLInputElement).checked,
										)
									}
								/>
							) : v.type === "color" ? (
								<input
									type="color"
									value={String(v.value)}
									oninput={(ev: Event) =>
										void setVariable(
											v.id,
											(ev.target as HTMLInputElement).value,
										)
									}
								/>
							) : (
								<input
									type={v.type === "number" ? "number" : "text"}
									value={String(v.value)}
									oninput={(ev: Event) =>
										void setVariable(
											v.id,
											v.type === "number"
												? Number((ev.target as HTMLInputElement).value)
												: (ev.target as HTMLInputElement).value,
										)
									}
								/>
							)}
							<button
								type="button"
								class="ov-var-del"
								title={t("overlay.delete")}
								onclick={() => void deleteVariable(v.id)}
							>
								✕
							</button>
						</div>
					))
				)}
			</div>
		</Card>
	);
}
