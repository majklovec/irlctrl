/**
 * Encoder settings module: the pipeline repositories.
 *
 * Visible for the encoder/combined roles, and for the custom role when the
 * server reports the encoder module as enabled. Default-exports its
 * ModuleDef; the settings framework registers it from the generated
 * manifest (modules/.generated.settings.ts) — no per-module imports.
 */
import m from "mithril";
import {
    Actions,
    Break,
    Button,
    Field,
    Form,
    Input,
} from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import type { ModuleContext, ModuleDef } from "../../public/ts/modules";

const REPO_PATTERN = "[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+";

/** Editable copy; repositories mirrors the server's current state. */
const state = {
    repository: "",
    repositories: [] as string[],
};

async function addRepository(ctx: ModuleContext): Promise<void> {
    const repository = state.repository.trim();
    if (!repository) return;
    ctx.note(t("set.repo_importing", repository));
    const response = await ctx.run(() =>
        ctx.rpc.call<{ repositories: string[]; result: { files: number } }>(
            "pipelines.repositories.add",
            { repository },
        ),
    );
    state.repositories = response.repositories;
    state.repository = "";
    ctx.note(t("set.repo_imported", response.result.files));
}

async function removeRepository(
    ctx: ModuleContext,
    repository: string,
): Promise<void> {
    ctx.note(t("set.repo_removing", repository));
    const result = await ctx.run(() =>
        ctx.rpc.call<{ repositories: string[] }>(
            "pipelines.repositories.remove",
            { repository },
        ),
    );
    state.repositories = result.repositories;
    ctx.note(t("set.repo_removed", repository));
}

async function updateAllRepositories(ctx: ModuleContext): Promise<void> {
    ctx.note(t("set.repo_updating_all"));
    const response = await ctx.run(() =>
        ctx.rpc
            .call<{ results: { repository: string; files: number }[] }>(
                "pipelines.repositories.updateAll",
            ),
    );
    const files = response.results.reduce((total, r) => total + r.files, 0);
    ctx.note(t("set.repo_updated_all", response.results.length, files));
}

export const def: ModuleDef = {
    id: "encoder",
    titleKey: "set.repos",
    visible: (ctx) =>
        ctx.role === "encoder" ||
        ctx.role === "combined" ||
        (ctx.role === "custom" && ctx.modules.encoder.enabled === true),
    refresh: (ctx) => {
        state.repositories = ctx.settings.pipelineRepositories;
    },
    render: (ctx) => [
        <p class={"muted"} key={"hint"}>{t("set.repos_desc")}</p>,
        <Form key={"form"} onSubmit={() => void addRepository(ctx)}>
            <Field
                label={t("set.repo_field")}
                control={
                    <Input
                        target={state}
                        prop="repository"
                        required={true}
                        pattern={REPO_PATTERN}
                        placeholder={"author/repository"}
                    />
                }
            />
            <Break />
            <Actions>
                <Button
                    label={t("set.repo_add")}
                    type={"submit"}
                    disabled={ctx.busy}
                />
                <Button
                    label={t("set.repo_update_all")}
                    class={"secondary"}
                    disabled={ctx.busy}
                    onclick={() => void updateAllRepositories(ctx)}
                />
            </Actions>
        </Form>,
        // Spread the repo rows into the outer fragment: a nested array would
        // be an unkeyed vnode among keyed siblings and Mithril rejects that.
        ...(state.repositories.length
            ? state.repositories.map((repository) => (
                  <div class={"card-head"} key={repository}>
                      <code>{repository}</code>
                      <Button
                          label={t("ui.remove")}
                          class={"danger"}
                          onclick={() =>
                              void removeRepository(ctx, repository)
                          }
                      />
                  </div>
              ))
            : [
                  <p key={"none"} class={"muted"}>
                      {t("set.no_repos")}
                  </p>,
              ]),
    ],
};

export default def;
