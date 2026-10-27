/* SSH card: sshd state, the login account, and the start / stop /
 * password-reset actions. A staged password (not yet applied, because the
 * account is only writable while sshd runs) is flagged with a "pending"
 * badge; it lands on the account at the next Start. */
import m from "mithril";
import {
	Actions,
	Badge,
	Button,
	Card,
	DefinitionList,
} from "../../frontend/ts/components/ui";
import { card, type DeviceCard } from "../../frontend/ts/device/store";
import { t } from "../../frontend/ts/i18n";
import type { FrontendModule } from "../../frontend/ts/module-contracts";
import log from "./log";
import "./styles.css";
import type { SshStatus } from "./types";

/** Per-connection card state (the fresh password is shown once, until the card unmounts). */
interface SshCardState {
	newPassword: string | null;
}

const sshStates = new WeakMap<DeviceCard, SshCardState>();

function sshState(host: DeviceCard): SshCardState {
	let state = sshStates.get(host);
	if (!state) {
		state = { newPassword: null };
		sshStates.set(host, state);
	}
	return state;
}

async function resetPassword(host: DeviceCard): Promise<void> {
	const user = (host.st.status as SshStatus | null)?.ssh?.user ?? "root";
	if (!confirm(t("dev.ssh_reset_confirm", { user }))) return;
	const result = await host.act<{ user: string; password: string }>(
		"ssh-reset",
		"ssh.reset_password",
	);
	if (result) {
		sshState(host).newPassword = result.password;
		m.redraw();
	}
}

function sshCardBody(host: DeviceCard, status: SshStatus): m.Vnode {
	const s = status.ssh;
	const { newPassword } = sshState(host);
	return (
		<Card title={t("dev.card.ssh")} class="mod-ssh">
			<DefinitionList
				rows={[
					[
						t("dev.row.state"),
						s?.active ? (
							<Badge text={t("dev.badge.online")} kind="on" />
						) : (
							<Badge text={t("dev.badge.stopped")} kind="off" />
						),
					],
					[t("dev.row.user"), s?.user ?? null],
					[
						t("dev.row.password"),
						s?.password ? (
							s?.pendingPassword ? (
								<span class="ssh-pending">
									<code class="ssh-password-code">{s.password}</code>
									<Badge
										text={t("dev.ssh_pending_apply")}
										kind="warn"
									/>
								</span>
							) : (
								<code class="ssh-password-code">{s.password}</code>
							)
						) : (
							<Badge text={t("dev.badge.password_none")} kind="warn" />
						),
					],
				]}
			/>
			{newPassword && (
				<p class="ssh-password">
					{t("dev.ssh_new_password")}: <code>{newPassword}</code>
				</p>
			)}
			<Actions>
				<Button
					label={t("ui.start")}
					disabled={!!s?.active || host.pending("ssh-start")}
					onclick={() => host.press("ssh-start", "ssh.start")}
				/>
				<Button
					label={t("ui.stop")}
					class="danger"
					disabled={!s?.active || host.pending("ssh-stop")}
					onclick={() => host.press("ssh-stop", "ssh.stop")}
				/>
				<Button
					label={t("dev.ssh_new_password")}
					disabled={!!s?.active || host.pending("ssh-reset")}
					title={s?.active ? t("set.ssh_stop_hint") : undefined}
					onclick={() => void resetPassword(host)}
				/>
			</Actions>
		</Card>
	);
}

const sshModule: FrontendModule = {
	id: "ssh",
	kind: "device-card",
	title: "SSH",
	order: 40,
	available: (status) => status.role !== "obs",
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	component: (status) => sshCardBody(card, status as SshStatus),
	log,
};

export default sshModule;
