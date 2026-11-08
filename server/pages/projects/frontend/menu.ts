import type { MenuContribution } from "../../../core/contracts";

/* The projects page's menu entry (consumed by server/shell/nav via the
 * generated MENUS manifest). */
const menu: MenuContribution = {
    id: "projects",
    labelKey: "mgmt.projects",
    path: "/projects/",
    order: 5,
};

export default menu;
