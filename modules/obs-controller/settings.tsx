/**
 * obs-controller settings module: the OBS connection (URL + password).
 *
 * Has its own save (modules.configure) independent of the device settings.
 * Visible for the obs role, and for the custom role when the server
 * reports the obs-controller module as enabled. Default-exports its
 * ModuleDef; the settings framework registers it from the generated
 * manifest (modules/.generated.settings.ts) — no per-module imports.
 */
import m from "mithril";
import {
    Actions,
    Button,
    Field,
    Form,
    Input,
    Break,
} from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import type { ModuleContext, ModuleDef } from "../../public/ts/modules";

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
        ctx.rpc.call<{ modules: ModuleContext["modules"] }>(
            "modules.configure",
            {
                id: "obs-controller",
                config: {
                    obsUrl: draft.obsUrl,
                    ...(obsPassword ? { obsPassword } : {}),
                },
            },
        ),
    );
    ctx.setModules(result.modules);
    draft.obsPassword = "";
    ctx.note(t("set.saved"));
}

export const def: ModuleDef = {
    id: "obs-controller",
    titleKey: "set.obs",
    visible: (ctx) =>
        ctx.role === "obs" ||
        (ctx.role === "custom" &&
            ctx.modules["obs-controller"].enabled === true),
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
            <p class={"muted"}>{t("set.obs_desc")}</p>,
            <Form key={"form"} onSubmit={() => void save(ctx)}>
                <Field
                    label={t("set.obs_url")}
                    control={
                        <Input
                            target={draft}
                            prop="obsUrl"
                            placeholder={"ws://127.0.0.1:4455"}
                        />
                    }
                />
                <Field
                    label={t("set.obs_password")}
                    control={
                        <Input
                            target={draft}
                            prop="obsPassword"
                            type={"password"}
                            autocomplete={"off"}
                            placeholder={passwordPlaceholder}
                        />
                    }
                />
                <Break />
                <Actions>
                    <Button
                        label={t("set.save")}
                        type={"submit"}
                        disabled={ctx.busy}
                    />
                </Actions>
            </Form>,
        ];
    },
};

export default def;
