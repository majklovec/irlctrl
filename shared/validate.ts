/*
 * Shared input validation: format rules and value ranges used on the wire API and
 * mirrored by the web UI (setup wizard, device page) so both accept the same values.
 * Dependency-free so the browser bundles can import it.
 */

export const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const REMOTE_URL_RE = /^wss?:\/\//;

export type { Role } from "./roles";

export const DEFAULT_COLOR = "#3b82f6";
import type { Role } from "./roles";
