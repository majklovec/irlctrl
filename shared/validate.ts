/*
 * Shared input validation: format rules and value ranges used on the wire API and
 * mirrored by the web UI (setup wizard, device page) so both accept the same values.
 * Dependency-free so the browser bundles can import it.
 */

export const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const REMOTE_URL_RE = /^wss?:\/\//;

/** Device types: relay bonds a stream out over its uplinks, encoder produces the
 *  stream, combined does both on one box, obs runs the OBS controls. Which modules
 *  serve a role is declared by the modules themselves (`roles`). */
export const ROLES = ["relay", "encoder", "combined", "obs", "srtla2platform"] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (v: unknown): v is Role =>
    (ROLES as readonly unknown[]).includes(v);

export const DEFAULT_COLOR = "#3b82f6";
