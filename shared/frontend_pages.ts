/*
 * The page entry points of each web UI (`<PAGE_DIRS[side]>/<name>.html`).
 * Module-owned pages (`<module>/pages/*.html`) are discovered on top of these
 * by shared/frontend.ts.
 */
export const CLIENT_PAGES = ["index", "settings", "setup"] as const;

export const SERVER_PAGES = [
    "login",
    "register",
    "devices",
    "profile",
    "dashboards",
    "dashboardview",
    "dashboardadd",
    "overlay_list",
    "overlay_update",
    "overlay_view",
] as const;

export const PAGES = [...CLIENT_PAGES, ...SERVER_PAGES] as const;

export type PageName = (typeof PAGES)[number];
