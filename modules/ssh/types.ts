/*
 * Local types for the ssh module (never imported by the core or other modules).
 */

/** The persisted configuration slice of the ssh module (the `modules.ssh` state). */
export interface SshModuleConfig {
	enabled: boolean;
	/** SSH login account (defaults to the box's admin user, "root"). */
	user?: string;
	/** Last generated password (secret — the status view reports it as `{configured}`). */
	password?: string;
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
}

/** Result of a password reset (the fresh password is shown once, then only its presence). */
export interface SshPasswordReset {
	user: string;
	password: string;
}

/** The slice of the core bag this module uses. */
export interface SshCore {
	config: {
		DRY_RUN: boolean;
	};
	state: {
		settings: {
			modules?: { ssh?: SshModuleConfig } & Record<string, unknown>;
		};
	};
	saveState(): Promise<void>;
	run(cmd: string, args: string[], ignoreError?: boolean): Promise<string>;
	errorMessage(err: unknown): string;
	logEvent(
		level: "info" | "warn" | "error",
		section: string,
		message: string,
	): void;
	t(key: string, options?: Record<string, unknown>): string;
}

/** The context the registry passes to `start`/`bind`. */
export interface Mctx {
	config: Record<string, unknown>;
	emit(event: string, data: unknown): void;
	log(section: string, message: string): void;
	core: SshCore;
}

/** A browser-side module registration (frontend). Local copy so a module never
 * imports across boundaries; the frontend registry narrows it. */
export interface BridgedModule extends FrontendModuleContributions {
	id: string;
	title: string;
	icon?: string;
	kind: "device-card";
	component: unknown;
	defaultSize: { w: number; h: number };
	minSize: { w: number; h: number };
	maxSize?: { w: number; h: number };
}

import type { FrontendModuleContributions } from "../../frontend/ts/module-contracts";
