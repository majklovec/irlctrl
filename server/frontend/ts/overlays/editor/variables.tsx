import { Button, Card } from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import m from "mithril";
import type { Variable } from "../../../../../shared/overlay";
import {
	copyVariableUrl,
	createVariable,
	deleteVariable,
	setVariable,
	state,
	variableUsage,
} from "../overlay_store";

/** A variable's current value, edited in place. Checkbox for booleans, a
 * colour swatch for colours, a number/text field otherwise. */
function varValueInput(v: Variable): m.Vnode {
	if (v.type === "boolean")
		return (
			<input
				type="checkbox"
				checked={Boolean(v.value)}
				onchange={(ev: Event) =>
					void setVariable(v.id, (ev.target as HTMLInputElement).checked)
				}
			/>
		);
	if (v.type === "color")
		return (
			<input
				type="color"
				value={String(v.value)}
				oninput={(ev: Event) =>
					void setVariable(v.id, (ev.target as HTMLInputElement).value)
				}
			/>
		);
	return (
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
	);
}

/** One variable's row: name, a type chip, the value editor, a "used by N
 * fields" badge, and hover-revealed copy / delete actions. */
function varRow(v: Variable): m.Vnode {
	const usage = variableUsage(v.id);
	const copied = state.copiedVariableName === v.name;
	return (
		<div key={v.id} class="ov-var">
			<span class="ov-var-name" title={v.name}>
				{v.name}
			</span>
			<span class={`ov-var-type ov-var-type-${v.type}`} title={v.type}>
				{v.type}
			</span>
			<span class="ov-var-val">{varValueInput(v)}</span>
			<span
				class={usage ? "ov-var-usage" : "ov-var-usage ov-unused"}
				title={
					usage ? t("overlay.usage_one", { count: usage }) : t("overlay.unused")
				}
			>
				{usage ? t("overlay.usage_one", { count: usage }) : t("overlay.unused")}
			</span>
			<span class="ov-var-actions">
				<button
					type="button"
					class={copied ? "ov-var-copy ov-copied" : "ov-var-copy"}
					title={copied ? t("overlay.copied") : t("overlay.copy_variable_url")}
					aria-label={t("overlay.copy_variable_url")}
					onclick={() => void copyVariableUrl(v.name)}
				>
					<Icon name="copy" class="role-icon" />
				</button>
				<button
					type="button"
					class="ov-var-del"
					title={t("overlay.delete")}
					aria-label={t("overlay.delete")}
					onclick={() => void deleteVariable(v.id)}
				>
					<Icon name="close" class="role-icon" />
				</button>
			</span>
		</div>
	);
}

export function variablesPanel(): m.Vnode {
	const vars = state.project.variables;
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
				{vars.length === 0 ? (
					<p class="muted">{t("overlay.no_variables")}</p>
				) : (
					vars.map(varRow)
				)}
			</div>
		</Card>
	);
}
