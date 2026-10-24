/*
 * ssh module: sshd process management — start / stop and password reset for
 * the box's SSH account.
 *
 * Self-contained: the only core edge is the `core` bag handed in at start.
 * Works both on a systemd host (systemctl ssh) and in the test container
 * (plain sshd daemon with a pid file, no init system).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type {
	Mctx,
	SshCore,
	SshHostStatus,
	SshPasswordReset,
} from "./types";

/** Core bag, filled at bind (discovery) and re-filled at start (a module may not import the core directly). */
let core: SshCore;

const PID_FILE = "/run/sshd.pid";

const hasSystemd = (): boolean => existsSync("/run/systemd/system");

const sshUser = (): string =>
	core.state.settings.modules?.ssh?.user ?? "root";

function daemonPid(): number | null {
	try {
		const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
		return pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isDaemonRunning(): boolean {
	const pid = daemonPid();
	if (pid === null) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function isActive(): Promise<boolean> {
	if (hasSystemd()) {
		const out = (await core.run("systemctl", ["is-active", "ssh"], true))
			.trim();
		return out === "active";
	}
	return isDaemonRunning();
}

/**
 * Wait until the daemon state reaches `want` — `sshd` forks and the pid file
 * appears a few ms after the command returns, and a stopped daemon takes a
 * moment to die. Resolves false on timeout (the status simply reports the
 * old state).
 */
async function waitActive(want: boolean, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if ((await isActive()) === want) return true;
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 150));
	}
}

async function sshStatus(): Promise<SshHostStatus> {
	const slice = core.state.settings.modules?.ssh;
	const password = slice?.password;
	return {
		user: sshUser(),
		active: await isActive(),
		password: password || null,
		passwordConfigured: Boolean(password),
		// A staged password that has not reached the account yet — it is
		// applied when sshd starts.
		pendingPassword: Boolean(password && password !== slice?.appliedPassword),
	};
}

/**
 * Apply the staged password to the account (chpasswd) and record it as the
 * applied baseline. Callers handle persistence; this only changes the slice.
 */
async function applyStagedPassword(user: string): Promise<void> {
	const slice = core.state.settings.modules?.ssh;
	const password = slice?.password;
	if (!slice || !password) return;
	if (slice.appliedPassword === password) return;
	// Ensure the account exists (idempotent) — chpasswd needs it.
	const uid = await core.run("id", ["-u", user], true);
	if (!uid.trim()) {
		await core.run("useradd", ["-m", "-s", "/bin/bash", user]);
	}
	await setAccountPassword(user, password);
	slice.appliedPassword = password;
}

/**
 * Stage a password on the module slice (no chpasswd yet). The value is the
 * one the operator sees in the UI; it reaches the account when sshd starts.
 */
function stagePassword(user: string, password: string): void {
	const settings = core.state.settings;
	if (!settings.modules) settings.modules = {};
	if (!settings.modules.ssh) settings.modules.ssh = { enabled: false };
	const slice = settings.modules.ssh;
	slice.user = user;
	slice.password = password;
}

async function startSsh(params: Record<string, unknown>): Promise<SshHostStatus> {
	// Starting also saves the SSH card's settings: the enabled flag and the
	// login account persist under modules.ssh before the daemon comes up.
	const slice = core.state.settings.modules?.ssh;
	let user = sshUser();
	if (slice) {
		slice.enabled = true;
		if (typeof params.user === "string" && params.user.trim())
			slice.user = params.user.trim();
		user = slice.user || user;
		// A password staged while sshd was stopped reaches the account now —
		// the change is made on start, never while the daemon is down.
		await applyStagedPassword(user);
	}
	if (slice) await core.saveState();
	if (hasSystemd()) {
		await core.run("systemctl", ["start", "ssh"]);
	} else {
		// sshd refuses to start without its privilege-separation directory.
		if (!core.config.DRY_RUN) mkdirSync("/run/sshd", { recursive: true });
		await core.run("sshd", ["-o", `PidFile=${PID_FILE}`]);
	}
	await waitActive(true);
	return sshStatus();
}

async function stopSsh(): Promise<SshHostStatus> {
	if (hasSystemd()) {
		await core.run("systemctl", ["stop", "ssh"]);
	} else {
		const pid = daemonPid();
		if (pid !== null) {
			if (!core.config.DRY_RUN) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// already gone
				}
			}
		} else {
			await core.run("pkill", ["-x", "sshd"], true);
		}
	}
	await waitActive(false);
	return sshStatus();
}

/** 20 alphanumerics (base64 minus +/=) — safe for all clients and URLs. */
function generatePassword(): string {
	return randomBytes(24)
		.toString("base64")
		.replace(/[+/=]/g, "")
		.substring(0, 20);
}

/** Feed "user:password" to chpasswd over stdin (no shell is involved). */
async function setAccountPassword(
	user: string,
	password: string,
): Promise<void> {
	if (core.config.DRY_RUN) return;
	const proc = Bun.spawn(["chpasswd"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdin = proc.stdin;
	if (stdin) {
		stdin.write(`${user}:${password}\n`);
		stdin.end();
	}
	const code = await proc.exited;
	if (code !== 0) {
		const err = (await new Response(proc.stderr).text()).trim();
		throw new Error(`chpasswd failed (${code}): ${err}`);
	}
}

async function resetPassword(
	params: Record<string, unknown>,
): Promise<SshPasswordReset> {
	const user =
		(typeof params.user === "string" && params.user.trim()) || sshUser();
	if (!user) throw new Error("user is required");
	// Staging is only meaningful with sshd down — while it runs, the account
	// password may not change.
	if (await isActive())
		throw new Error(core.t("ssh.reset_blocked"));

	const password = generatePassword();
	stagePassword(user, password);
	await core.saveState();
	core.logEvent(
		"info",
		"ssh",
		core.t("mlog.done.ssh_password_reset", { user }),
	);
	return { user, password };
}

/** Stage the operator-supplied password (applied to the account at start). */
async function setPassword(params: Record<string, unknown>): Promise<{ user: string }> {
	const user =
		(typeof params.user === "string" && params.user.trim()) || sshUser();
	const password =
		typeof params.password === "string" ? params.password.trim() : "";
	if (!user) throw new Error("user is required");
	if (!password) throw new Error("password is required");
	if (await isActive())
		throw new Error(core.t("ssh.reset_blocked"));

	stagePassword(user, password);
	await core.saveState();
	core.logEvent(
		"info",
		"ssh",
		core.t("mlog.done.ssh_password_set", { user }),
	);
	return { user };
}

const methods = [
	"ssh.status",
	"ssh.start",
	"ssh.stop",
	"ssh.reset_password",
	"ssh.set_password",
] as const;

export default {
	kind: "device",
	id: "ssh",
	title: "SSH",
	configSchema: z.object({}).passthrough(),
	// No secret fields — the generated password is intentionally visible in
	// the status so the operator can always read it from the UI.
	secretFields: [] as string[],
	bind(c: SshCore) {
		core = c;
	},
	async start(ctx: Mctx) {
		core = ctx.core;
	},
	async stop() {},
	methods,
	events: [] as string[],
	async dispatch(method: string, params: Record<string, unknown>) {
		switch (method) {
			case "ssh.status":
				return sshStatus();
			case "ssh.start":
				return startSsh(params);
			case "ssh.stop":
				return stopSsh();
			case "ssh.reset_password":
				return resetPassword(params);
			case "ssh.set_password":
				return setPassword(params);
		}
		throw new Error(`unknown method ${method}`);
	},
	async status() {
		return { ssh: await sshStatus() };
	},
};
