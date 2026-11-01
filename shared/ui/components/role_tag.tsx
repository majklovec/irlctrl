/** @jsx m */
/* Generic role marker with the translated role as tooltip; the pictogram
 * comes from the module that provides the role (`roleIcon` in the module
 * registry), so no role id is drawn in core code. */
import m from "mithril";
import type { Role } from "../../contracts/roles";
import { t } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";
import { roleIcon } from "../module_registry";

export const RoleTag = {
	view: ({ attrs: { role } }) => (
		<span class={`role role-${role}`} title={t(`role.${role}`)}>
			{roleIcon(role) ?? null}
		</span>
	),
} as MithrilJSXComponent<{ role: Role }>;
