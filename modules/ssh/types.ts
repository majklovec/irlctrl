/*
 * Local types for the ssh module (never imported by the core or other modules).
 */
import type { ModuleSliceView } from "../../shared/types";

/** The persisted configuration slice of the ssh module (the `modules.ssh` state). */
export interface SshModuleConfig {
    enabled: boolean;
    /** SSH login account (defaults to the box's admin user, "root"). */
    user?: string;
    /**
     * The staged password (secret — the status view reports it as
     * `{configured}`). It reaches the account via chpasswd when sshd starts.
     */
    password?: string;
    /** The password last applied to the account (baseline for staging). */
    appliedPassword?: string;
}

/** Live ssh state (the status `ssh` fragment, the `ssh.status` result). */
export interface SshHostStatus {
    /** The account SSH logins use. */
    user: string;
    /** sshd is accepting connections. */
    active: boolean;
    /** The account's current password (null when none is set). */
    password: string | null;
    /** A password has been generated for the account. */
    passwordConfigured: boolean;
    /** A staged password is waiting to be applied — it lands on SSH start. */
    pendingPassword: boolean;
}

/** Result of a password reset (the fresh password is shown once, then only its presence). */
export interface SshPasswordReset {
    user: string;
    password: string;
}

/** The module's slice of the modules view — safeModules() masks the password as `{configured}`. */
export interface SshSliceView extends ModuleSliceView {
    user?: string;
    password?: { configured: boolean };
}
