/**
 * SSH server controls for the Settings page.
 *
 * Visible for the relay/encoder/combined roles (and the custom role when the
 * server reports the ssh module as enabled). The account and enable flag live
 * under `modules.ssh` (via `modules.configure`); the password is write-only —
 * the device only ever reports it as `{configured}`. A typed password is
 * applied live through `ssh.set_password`; the reset button generates a fresh
 * one through `ssh.reset_password` and shows it once.
 *
 * Default-exports its ModuleDef; the settings framework registers it from the
 * generated manifest (generated/modules.settings.ts) — no per-module imports.
 */
import m from "mithril";
import {
	Actions,
	Break,
	Button,
	CheckField,
	Checkbox,
	Field,
	Form,
	Input,
} from "../../frontend/ts/components/ui";
import { t } from "../../frontend/ts/i18n";
import type { ModuleContext, ModuleDef } from "../../frontend/ts/modules";
import "./styles.css";

/**
 * Editable copy of the module's SSH account. `password` is only ever sent when
 * the operator types one; the device never returns it.
 */
const draft = {
	enabled: false,
	user: "root",
	password: "",
};

/** One-shot generated password from a reset; cleared on the next save/reset. */
let newPassword: string | null = null;

async function save(ctx: ModuleContext): Promise<void> {
	const { password } = draft;
	// Account + enable flag persist under modules.ssh.
	const result = await ctx.run(() =>
		ctx.rpc.call<{ modules: ModuleContext["modules"] }>("modules.configure", {
			id: "ssh",
			config: { enabled: draft.enabled, user: draft.user },
		}),
	);
	ctx.setModules(result.modules);

	// A typed password is applied to the live sshd account and persisted.
	if (password) {
		await ctx.run(() =>
			ctx.rpc.call<{ user: string }>("ssh.set_password", {
				user: draft.user,
				password,
			}),
		);
		draft.password = "";
		newPassword = null;
	}
	ctx.note(t("set.saved"));
}

async function resetPassword(ctx: ModuleContext): Promise<void> {
	if (!window.confirm(t("dev.ssh_reset_confirm", { user: draft.user }))) {
		return;
	}
	const result = await ctx.run(() =>
		ctx.rpc.call<{ user: string; password: string }>("ssh.reset_password", {
			user: draft.user,
		}),
	);
	draft.user = result.user;
	newPassword = result.password;
	ctx.note(t("set.ssh_reset_done", { user: result.user }));
	m.redraw();
}

export const def: ModuleDef = {
	id: "ssh",
	titleKey: "set.ssh",
	visible: (ctx) =>
		ctx.role === "relay" ||
		ctx.role === "encoder" ||
		ctx.role === "combined",
	refresh: (ctx) => {
		const s = ctx.modules.ssh;
		draft.enabled = s.enabled === true;
		draft.user = s.user ?? "root";
		draft.password = "";
		newPassword = null;
	},
	render: (ctx) => {
		const account = ctx.modules.ssh;
		const passwordState = account.password;
		const passwordPlaceholder = !passwordState
			? t("set.token_ph_unchanged")
			: typeof passwordState === "object" && passwordState.configured
				? t("set.token_ph_configured")
				: t("set.token_ph_missing");
		return [
			<p class="muted" key="hint">
				{t("set.ssh_desc")}
			</p>,
			<Form key="form" onSubmit={() => void save(ctx)}>
				<CheckField
					label={t("set.ssh_enable")}
					control={<Checkbox target={draft} prop="enabled" />}
				/>
				<Field
					label={t("dev.row.user")}
					control={<Input target={draft} prop="user" autocomplete="off" />}
				/>
				<Field
					label={t("dev.row.password")}
					control={
						<Input
							target={draft}
							prop="password"
							type="password"
							autocomplete="off"
							placeholder={passwordPlaceholder}
						/>
					}
				/>
				{newPassword ? (
					<p class="ssh-password" key="newpass">
						{t("dev.ssh_new_password")}{" "}
						<code>{newPassword}</code>
					</p>
				) : null}
				<Break />
				<Actions>
					<Button label={t("set.save")} type="submit" disabled={ctx.busy} />
					<Button
						label={t("ui.reset_password")}
						disabled={ctx.busy}
						onClick={() => void resetPassword(ctx)}
					/>
				</Actions>
			</Form>,
		];
	},
};

export default def;
