// Select config fields for the dashboard edit form and the add-widget form.
// A module can override one field's options at runtime (`configSelectOptions`
// — e.g. the chat widget's speech voices, which only the browser knows);
// until those arrive the select shows a placeholder and the saved value, if
// any.
import m from "mithril";
import type { VisibleWidgetConfigField } from "../types";
import { t } from "./i18n";
import type { ChannelWidgetModule } from "./module-contracts";

/** A visible select field (the non-string, non-hidden `WidgetConfigField`). */
type SelectField = Extract<VisibleWidgetConfigField, { type: "select" }>;

/** The `<option>` children plus the `value` attribute of one select field. */
interface ConfigSelect {
	value: string;
	options: m.Children;
}

/**
 * The effective options of a select config field: a module's dynamic options
 * (labels are the raw values; a saved value missing from the list is prepended
 * so it keeps being visible), a loading placeholder while a dynamic list is
 * empty, or the field's static options with translated labels.
 */
export function configSelectField(
	field: SelectField,
	module: ChannelWidgetModule | undefined,
	current: string,
): ConfigSelect {
	const name = field.name;
	const dynamic = module?.configSelectOptions?.(name);

	if (dynamic !== undefined) {
		if (dynamic.length) {
			const options =
				current && !dynamic.includes(current) ? [current, ...dynamic] : dynamic;
			return {
				value: current,
				options: options.map((opt) => (
					<option key={opt} value={opt}>
						{opt}
					</option>
				)),
			};
		}
		// Dynamic list still loading (voices arrive on an async event).
		return {
			value: current,
			options: (
				<option key="loading" value={current} disabled={!current}>
					{current || t(`dash.widget_${name}`)}
				</option>
			),
		};
	}

	return {
		value: current ?? field.options[0] ?? "",
		options: field.options.map((opt) => (
			<option key={opt} value={opt}>
				{t(`dash.widget_${name}.${opt}`)}
			</option>
		)),
	};
}
