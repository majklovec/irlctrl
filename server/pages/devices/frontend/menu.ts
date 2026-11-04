import type { MenuContribution } from "../../../core/contracts";

/* The devices page's menu entry (consumed by server/shell/nav via the
 * generated MENUS manifest). */
const menu: MenuContribution = {
	id: "devices",
	labelKey: "mgmt.devices",
	path: "/devices/",
	order: 10,
};

export default menu;
