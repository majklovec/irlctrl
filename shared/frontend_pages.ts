/*
 * The page entry points of each web UI (`<PAGE_DIRS[side]>/<name>.html`).
 * Module-owned pages (`<module>/pages/*.html`) and page-slice pages
 * (`server/pages/<id>/pages/*.html`) are discovered on top of these by
 * shared/frontend.ts.
 */
export const CLIENT_PAGES = ["index", "settings", "setup"] as const;

export const SERVER_PAGES = ["login", "register", "profile"] as const;

export const PAGES = [...CLIENT_PAGES, ...SERVER_PAGES] as const;

export type PageName = (typeof PAGES)[number];
