import {
	Actions,
	Break,
	Button,
	Field,
	Form,
	Input,
} from "../../frontend/ts/components/ui";
import { t } from "../../frontend/ts/i18n";
import type { ModuleContext, ModuleDef } from "../../frontend/ts/modules";

/**
 * Editable copy of the module's OBS connection; the password is write-only
 * — the device only ever reports it as {configured}.
 */
const draft = {
	obsUrl: "",
	obsPassword: "",
};

async function save(ctx: ModuleContext): Promise<void> {
	const { obsPassword } = draft;
	const result = await ctx.run(() =>
		ctx.rpc.call<{ modules: ModuleContext["modules"] }>("modules.configure", {
			id: "obs-controller",
			config: {
				obsUrl: draft.obsUrl,
				...(obsPassword ? { obsPassword } : {}),
			},
		}),
	);
	ctx.setModules(result.modules);
	draft.obsPassword = "";
	ctx.note(t("set.saved"));
}

export const def: ModuleDef = {
	id: "obs-controller",
	titleKey: "set.obs",
	visible: (ctx) => ctx.role === "obs",
	refresh: (ctx) => {
		draft.obsUrl = ctx.modules["obs-controller"].obsUrl;
		draft.obsPassword = "";
	},
	render: (ctx) => {
		const obsPassword = ctx.modules["obs-controller"].obsPassword;
		const passwordPlaceholder = !obsPassword
			? t("set.token_ph_unchanged")
			: typeof obsPassword === "object" && obsPassword.configured
				? t("set.token_ph_configured")
				: t("set.token_ph_missing");
		return [
			<p class="muted" key="hint">
				{t("set.obs_desc")}
			</p>,
			<Form key="form" onSubmit={() => void save(ctx)}>
				<Field
					label={t("set.obs_url")}
					control={
						<Input
							target={draft}
							prop="obsUrl"
							placeholder="ws://127.0.0.1:4455"
						/>
					}
				/>
				<Field
					label={t("set.obs_password")}
					control={
						<Input
							target={draft}
							prop="obsPassword"
							type="password"
							autocomplete="off"
							placeholder={passwordPlaceholder}
						/>
					}
				/>
				<Break />
				<Actions>
					<Button label={t("set.save")} type="submit" disabled={ctx.busy} />
				</Actions>
			</Form>,
		];
	},
};

export default def;
