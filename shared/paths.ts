/*
 * The repository layout, in one place. Every piece of code that has to find
 * files on disk by convention (module discovery, i18n catalogs, page
 * bundling, static assets, the generators) reads these constants instead of
 * spelling the directories out, so a directory move touches only this file.
 *
 *   client/   the device process: backend, its web UI and the device modules
 *   server/   the control server: core, its page slices, its shell UI and
 *             the widget modules
 *   shared/   dependency-free helpers, contracts and the UI design system
 *             (components, CSS, static assets) both sides and all modules use
 */
import { fileURLToPath } from "node:url";

/** Absolute `file:` URL of the application root (the directory holding package.json). */
export const APP_ROOT = new URL("../", import.meta.url);

/**
 * Directories whose immediate children are modules (`<root>/<id>/backend.ts`).
 *
 * The control server's widget/overlay modules live inside the page slices that
 * consume them (01-refactor): the dashboards widgets under
 * `server/pages/dashboards/modules` and the overlays element/template modules
 * under `server/pages/overlays/modules`. A page that ships its own module adds
 * its `server/pages/<id>/modules` directory here.
 */
export const MODULE_ROOTS = [
    "client/modules",
    "server/pages/dashboards/modules",
    "server/pages/overlays/modules",
] as const;

/** Page entry points (`<dir>/<name>.html`) of each side's web UI. */
export const PAGE_DIRS = {
    client: "client/frontend/pages",
    server: "server/shell/pages",
} as const;

/** The control server's page slices (`server/pages/<id>/…`, 01-refactor). */
export const PAGES_ROOT = "server/pages";

/** The core translation catalogs (`i18n/<lang>.json`). */
export const CORE_I18N_DIR = "i18n";

/** Static assets shared by both web UIs (images, PWA files). */
export const ASSETS_DIR = "shared/assets";

/** Build-time generated manifests (gitignored). */
export const GENERATED_DIR = "generated";

/** Absolute filesystem path of a repository-relative directory or file. */
export const appPath = (relative: string): string =>
    fileURLToPath(new URL(relative, APP_ROOT));
