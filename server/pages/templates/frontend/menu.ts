import type { MenuContribution } from "../../../core/contracts";

/* The templates page's menu entry (consumed by server/shell/nav via the
 * generated MENUS manifest). */
const menu: MenuContribution = {
	id: "templates",
	labelKey: "mgmt.templates",
	path: "/templates/",
	order: 50,
};

export default menu;
