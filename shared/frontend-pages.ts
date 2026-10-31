export const PAGES = [
    "login",
    "register",
    "devices",
    "profile",
    "index",
    "settings",
    "setup",
    "dashboards",
    "dashboardview",
    "dashboardadd",
    "overlays",
    "overlay",
] as const;

export type PageName = (typeof PAGES)[number];
