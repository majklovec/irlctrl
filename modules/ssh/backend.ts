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

async function sshStatus(): Promise<SshHostStatus> {
	return {
		user: sshUser(),
		active: await isActive(),
		passwordConfigured: Boolean(
			core.state.settings.modules?.ssh?.password,
		),
	};
}

async function startSsh(): Promise<SshHostStatus> {
	if (hasSystemd()) {
		await core.run("systemctl", ["start", "ssh"]);
	} else {
		// sshd refuses to start without its privilege-separation directory.
		if (!core.config.DRY_RUN) mkdirSync("/run/sshd", { recursive: true });
		await core.run("sshd", ["-o", `PidFile=${PID_FILE}`]);
	}
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
	proc.stdin!.write(`${user}:${password}\n`);
	proc.stdin!.end();
	const code = await proc.exited;
	if (code !== 0) {
		const err = (await new Response(proc.stderr).text()).trim();
		throw new Error(`chpasswd failed (${code}): ${err}`);
	}
}

/** Ensure the account exists, set its password, and persist the state. */
async function applyPassword(user: string, password: string): Promise<void> {
	// Ensure the account exists (idempotent).
	const uid = await core.run("id", ["-u", user], true);
	if (!uid.trim()) {
		await core.run("useradd", ["-m", "-s", "/bin/bash", user]);
	}

	await setAccountPassword(user, password);

	const slice = core.state.settings.modules?.ssh;
	if (slice) {
		slice.user = user;
		slice.password = password;
	}
	await core.saveState();
}

async function resetPassword(
	params: Record<string, unknown>,
): Promise<SshPasswordReset> {
	const user =
		(typeof params.user === "string" && params.user.trim()) || sshUser();
	if (!user) throw new Error("user is required");

	const password = generatePassword();
	await applyPassword(user, password);
	core.logEvent(
		"info",
		"ssh",
		core.t("mlog.done.ssh_password_reset", { user }),
	);
	return { user, password };
}

/** Set the operator-supplied password on the SSH account. */
async function setPassword(
	params: Record<string, unknown>,
): Promise<{ user: string }> {
	const user =
		(typeof params.user === "string" && params.user.trim()) || sshUser();
	const password =
		typeof params.password === "string" ? params.password.trim() : "";
	if (!user) throw new Error("user is required");
	if (!password) throw new Error("password is required");

	await applyPassword(user, password);
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
	secretFields: ["password"] as string[],
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
				return startSsh();
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
