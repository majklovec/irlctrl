/** @jsx m */
/* Read-only data display: definition lists and compact widget tables. */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";
import type { Child } from "../util";

/** <dl> of dt/dd rows; empty values render "—". */
export const DefinitionList = {
	view: ({ attrs: { rows } }) => (
		<dl>{rows.flatMap(([k, v]) => [<dt>{k}</dt>, <dd>{v ?? "—"}</dd>])}</dl>
	),
} as MithrilJSXComponent<{ rows: [string, Child][] }>;

/** A <table> of th/td rows (dashboard widget bodies share this shape). */
export const WidgetTable = {
	view: ({ attrs: { rows } }) => (
		<table class="dash-table">
			<tbody>
				{rows.map(([label, value], i) => (
					<tr key={i}>
						<th>{label}</th>
						<td>{value}</td>
					</tr>
				))}
			</tbody>
		</table>
	),
} as MithrilJSXComponent<{ rows: [string, Child][] }>;
