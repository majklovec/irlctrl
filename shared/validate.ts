/*
 * Shared input validation: format rules and value ranges used on the wire API and
 * mirrored by the web UI (setup wizard, device page) so both accept the same values.
 * Dependency-free so the browser bundles can import it.
 */

export const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const REMOTE_URL_RE = /^wss?:\/\//;
/** Device web-login username: letters, digits and `._@-`, 1-64 characters. */
export const USERNAME_RE = /^[\p{L}\p{N}._@-]{1,64}$/u;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export type { Role } from "./contracts/roles";

export const DEFAULT_COLOR = "#3b82f6";

import type { Role } from "./contracts/roles";
