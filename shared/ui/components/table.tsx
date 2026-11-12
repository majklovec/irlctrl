/** @jsx m */
/* Entity list table: column headers plus rows; the last column holds the
 * per-row action icons (`RowActions`). */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";

export interface TableColumn {
	key: string;
	header: m.Children;
	/** Optional tooltip shown on the column-header cell. */
	title?: string;
}

export const Table = {
	view: ({ attrs: { columns, actions = true }, children }) => (
		<table class="dash-table">
			<thead>
				<tr>
					{columns.map((c) => (
						<th key={c.key} title={c.title ?? null}>
							{c.header}
						</th>
					))}
					{actions ? <th /> : null}
				</tr>
			</thead>
			<tbody>{children}</tbody>
		</table>
	),
} as MithrilJSXComponent<{ columns: TableColumn[]; actions?: boolean }>;

/** The actions cell of a table row: a right-aligned group of icon buttons. */
export const RowActions = {
	view: ({ children }) => (
		<td class="actions-cell">
			<div class="dash-row-actions">{children}</div>
		</td>
	),
} as MithrilJSXComponent;
