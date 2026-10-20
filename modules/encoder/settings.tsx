/**
 * Encoder settings module: pipeline repositories and pipeline files.
 *
 * Visible for the encoder/combined roles, and for the custom role when the
 * server reports the encoder module as enabled. Default-exports its
 * ModuleDef; the settings framework registers it from the generated
 * manifest (modules/.generated.settings.ts) — no per-module imports.
 *
 * One card, two sections:
 *  1. Pipeline repositories — add / update / remove GitHub mirrors, with a
 *     per-repository pipeline count.
 *  2. Pipeline files — list, create, edit and delete the GStreamer
 *     launch strings under the pipelines directory.
 */
import m from "mithril";
import {
    Actions,
    Badge,
    Break,
    Button,
    Card,
    Field,
    Form,
    Input,
} from "../../public/ts/components/ui";
import { actionIcon, chevronIcon } from "../../public/ts/components/icons";
import { t, tCount } from "../../public/ts/i18n";
import type { ModuleContext, ModuleDef } from "../../public/ts/modules";
import type { Pipeline } from "../../public/types";

const REPO_PATTERN = "[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+";
const PIPELINE_PATH_PATTERN = "[A-Za-z0-9_.\\-]+(\\/[A-Za-z0-9_.\\-]+)*";

/** The payload every `pipelines.*` response carries. */
interface PipelinesPayload {
    pipelines: Pipeline[];
    repositoryCounts: Record<string, number>;
}

/**
 * Editable copy; repositories/pipelines mirror the server's current state.
 * In the editor, `editingId` of "" means "creating a new pipeline" (its
 * target path is in `newPath`).
 */
const state = {
    repository: "",
    repositories: [] as string[],
    pipelines: [] as Pipeline[],
    counts: {} as Record<string, number>,
    editorOpen: false,
    editingId: "",
    newPath: "",
    content: "",
    // Group name → true when expanded. Groups default to folded.
    expandedGroups: {} as Record<string, boolean>,
};

function applyPayload(payload: PipelinesPayload): void {
    state.pipelines = payload.pipelines;
    state.counts = payload.repositoryCounts;
    m.redraw();
}

// Guards against an older, slower `pipelines.list` response clobbering
// the state a newer load (or create/update/delete) has already applied.
let loadSeq = 0;

/** Background list load; the page-level load already reports failures.
 * Retries a few times: right after a (re)start the device link to the
 * server is flapping and the first call can time out. */
async function loadPipelines(ctx: ModuleContext): Promise<void> {
    const seq = ++loadSeq;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
        try {
            const payload = await ctx.rpc.call<PipelinesPayload>(
                "pipelines.list",
            );
            if (seq === loadSeq) applyPayload(payload);
            return;
        } catch {
            // retry, see above
        }
    }
}

async function addRepository(ctx: ModuleContext): Promise<void> {
    const repository = state.repository.trim();
    if (!repository) return;
    ctx.note(t("set.repo_importing", repository));
    const response = await ctx.run(() =>
        ctx.rpc.call<
            PipelinesPayload & {
                repositories: string[];
                result: { files: number };
            }
        >("pipelines.repositories.add", { repository }),
    );
    state.repositories = response.repositories;
    state.repository = "";
    loadSeq++;
    applyPayload(response);
    ctx.note(t("set.repo_imported", response.result.files));
}

async function removeRepository(
    ctx: ModuleContext,
    repository: string,
): Promise<void> {
    ctx.note(t("set.repo_removing", repository));
    const response = await ctx.run(() =>
        ctx.rpc.call<PipelinesPayload & { repositories: string[] }>(
            "pipelines.repositories.remove",
            { repository },
        ),
    );
    state.repositories = response.repositories;
    loadSeq++;
    applyPayload(response);
    ctx.note(t("set.repo_removed", repository));
}

async function updateRepository(
    ctx: ModuleContext,
    repository: string,
): Promise<void> {
    ctx.note(t("set.repo_updating", repository));
    const response = await ctx.run(() =>
        ctx.rpc.call<PipelinesPayload & { result: { files: number } }>(
            "pipelines.repositories.update",
            { repository },
        ),
    );
    loadSeq++;
    applyPayload(response);
    ctx.note(t("set.repo_updated", repository, response.result.files));
}

async function updateAllRepositories(ctx: ModuleContext): Promise<void> {
    ctx.note(t("set.repo_updating_all"));
    const response = await ctx.run(() =>
        ctx.rpc.call<
            PipelinesPayload & {
                results: { repository: string; files: number }[];
            }
        >("pipelines.repositories.updateAll"),
    );
    loadSeq++;
    applyPayload(response);
    const files = response.results.reduce((total, r) => total + r.files, 0);
    ctx.note(t("set.repo_updated_all", response.results.length, files));
}

function toggleGroup(group: string): void {
    state.expandedGroups[group] = !state.expandedGroups[group];
    m.redraw();
}

function closeEditor(): void {
    state.editorOpen = false;
    state.editingId = "";
    state.newPath = "";
    state.content = "";
}

function openNewPipeline(): void {
    closeEditor();
    state.editorOpen = true;
}

async function openPipelineEditor(
    ctx: ModuleContext,
    pipeline: Pipeline,
): Promise<void> {
    const response = await ctx.run(() =>
        ctx.rpc.call<{ id: string; content: string }>("pipelines.get", {
            id: pipeline.id,
        }),
    );
    closeEditor();
    state.editorOpen = true;
    state.editingId = response.id;
    state.content = response.content;
    // Make sure the edited pipeline's group is visible.
    state.expandedGroups[pipeline.group] = true;
}

async function savePipeline(ctx: ModuleContext): Promise<void> {
    const id = (state.editingId || state.newPath).trim();
    if (!id) return;
    const isNew = state.editingId === "";
    const response = await ctx.run(() =>
        ctx.rpc.call<PipelinesPayload>(
            isNew ? "pipelines.create" : "pipelines.update",
            { id, content: state.content },
        ),
    );
    loadSeq++;
    applyPayload(response);
    closeEditor();
    ctx.note(
        isNew ? t("set.pipeline_created", id) : t("set.pipeline_updated", id),
    );
}

async function deletePipeline(
    ctx: ModuleContext,
    pipeline: Pipeline,
): Promise<void> {
    if (!window.confirm(t("set.pipeline_delete_confirm", pipeline.id))) return;
    const response = await ctx.run(() =>
        ctx.rpc.call<PipelinesPayload>("pipelines.delete", {
            id: pipeline.id,
        }),
    );
    loadSeq++;
    applyPayload(response);
    ctx.note(t("set.pipeline_deleted", pipeline.id));
}

export const def: ModuleDef = {
    id: "encoder",
    // selfCards: the module renders its own two titled cards ("Pipeline
    // repositories" and "Pipelines"); the framework skips its single card
    // wrapper, so titleKey is unused here.
    titleKey: "set.repos",
    selfCards: true,
    visible: (ctx) =>
        ctx.role === "encoder" ||
        ctx.role === "combined" ||
        (ctx.role === "custom" && ctx.modules.encoder.enabled === true),
    refresh: (ctx) => {
        state.repositories = ctx.settings.pipelineRepositories ?? [];
        void loadPipelines(ctx);
    },
    render: (ctx) => {
        const editorOpen = state.editorOpen;
        // Pipelines arrive sorted (group, name); the map keeps that order.
        const groups = new Map<string, Pipeline[]>();
        for (const pipeline of state.pipelines) {
            const list = groups.get(pipeline.group) ?? [];
            list.push(pipeline);
            groups.set(pipeline.group, list);
        }
        // Group header + rows as one flat list.
        const pipelineRows: m.Children[] =
            state.pipelines.length === 0
                ? [
                      <p class={"muted"}>
                          {t("set.pipelines_none")}
                      </p>,
                  ]
                : [...groups.entries()].flatMap(
                      ([group, pipelines]): m.Children[] => {
                          const expanded =
                              state.expandedGroups[group] === true;
                          return [
                              <div class={"pipe-group"}>
                                  <button
                                      type={"button"}
                                      class={
                                          "pipe-group-toggle" +
                                          (expanded ? " open" : "")
                                      }
                                      aria-expanded={expanded}
                                      disabled={ctx.busy}
                                      title={t(
                                          expanded
                                              ? "set.group_collapse"
                                              : "set.group_expand",
                                      )}
                                      aria-label={t(
                                          expanded
                                              ? "set.group_collapse"
                                              : "set.group_expand",
                                      ) +
                                          " " +
                                          group}
                                      onclick={() =>
                                          toggleGroup(group)
                                      }
                                  >
                                      {chevronIcon()}
                                      <span class={"pipe-group-name"}>
                                          {group}
                                      </span>
                                      <Badge
                                          text={tCount(
                                              "set.pipeline_count",
                                              pipelines.length,
                                          )}
                                      />
                                  </button>
                                  {expanded
                                      ? pipelines.map((pipeline) => (
                                            <div class={"card-head"}>
                                                <code>{pipeline.id}</code>
                                                <div
                                                    class={
                                                        "dash-row-actions"
                                                    }
                                                >
                                                    <Button
                                                        label={actionIcon(
                                                            "edit",
                                                        )}
                                                        class={
                                                            "icon-link"
                                                        }
                                                        title={t(
                                                            "set.pipeline_edit",
                                                        )}
                                                        aria-label={t(
                                                            "set.pipeline_edit",
                                                        )}
                                                        disabled={
                                                            ctx.busy ||
                                                            editorOpen
                                                        }
                                                        onclick={() =>
                                                            void openPipelineEditor(
                                                                ctx,
                                                                pipeline,
                                                            )
                                                        }
                                                    />
                                                    <Button
                                                        label={actionIcon(
                                                            "delete",
                                                        )}
                                                        class={
                                                            "icon-link dash-delete"
                                                        }
                                                        title={t(
                                                            "set.pipeline_delete",
                                                        )}
                                                        aria-label={t(
                                                            "set.pipeline_delete",
                                                        )}
                                                        disabled={
                                                            ctx.busy ||
                                                            editorOpen
                                                        }
                                                        onclick={() =>
                                                            void deletePipeline(
                                                                ctx,
                                                                pipeline,
                                                            )
                                                        }
                                                    />
                                                </div>
                                            </div>
                                        ))
                                       : null}
                              </div>,
                          ];
                      },
                  );
        const repositoryRows: m.Children[] = state.repositories.length
            ? state.repositories.map((repository) => (
                  <div class={"card-head"}>
                      <code>{repository}</code>
                      <div class={"dash-row-actions"}>
                          <Badge
                              text={tCount(
                                  "set.pipeline_count",
                                  state.counts[repository] ?? 0,
                              )}
                          />
                          <Button
                              label={actionIcon("sync")}
                              class={"icon-link"}
                              title={t("set.repo_update")}
                              aria-label={t("set.repo_update")}
                              disabled={ctx.busy}
                              onclick={() =>
                                  void updateRepository(ctx, repository)
                              }
                          />
                          <Button
                              label={actionIcon("delete")}
                              class={"icon-link dash-delete"}
                              title={t("ui.remove")}
                              aria-label={t("ui.remove")}
                              disabled={ctx.busy}
                              onclick={() =>
                                  void removeRepository(ctx, repository)
                              }
                          />
                      </div>
                  </div>
              ))
            : [t("set.no_repos")];
        const repositoriesChildren: m.Children[] = [
            <p class={"muted"}>{t("set.repos_desc")}</p>,
            <Form onSubmit={() => void addRepository(ctx)}>
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
            ...repositoryRows,
        ];
        const editorElement: m.Children = editorOpen ? (
            <Form
                class={"pipeline-editor"}
                onSubmit={() => void savePipeline(ctx)}
            >
                <div class={"pipeline-editor-head"}>
                    <span class={"pipeline-editor-title"}>
                        {state.editingId
                            ? t("set.pipeline_editing", state.editingId)
                            : t("set.pipeline_new")}
                    </span>
                    <code class={"pipeline-editor-id"}>
                        {state.editingId || state.newPath}
                    </code>
                </div>
                {state.editingId === "" ? (
                    <Field
                        label={t("set.pipeline_path")}
                        control={
                            <Input
                                target={state}
                                prop="newPath"
                                required={true}
                                pattern={PIPELINE_PATH_PATTERN}
                                placeholder={t("set.pipeline_path_ph")}
                            />
                        }
                    />
                ) : null}
                <Field
                    label={t("set.pipeline_content")}
                    control={
                        <textarea
                            class={"pipeline-editor-text"}
                            rows={14}
                            spellCheck={false}
                            value={state.content}
                            oninput={(e: Event) => {
                                state.content = (
                                    e.target as HTMLTextAreaElement
                                ).value;
                            }}
                            onkey={(e: Event) => {
                                const key = e as KeyboardEvent;
                                if (
                                    (key.ctrlKey || key.metaKey) &&
                                    key.key === "s"
                                ) {
                                    key.preventDefault();
                                    void savePipeline(ctx);
                                }
                            }}
                        />
                    }
                />
                <div class={"pipeline-editor-actions"}>
                    <Button
                        label={
                            state.editingId !== ""
                                ? t("ui.save")
                                : t("set.pipeline_add")
                        }
                        type={"submit"}
                        title={t("set.pipeline_save_hint")}
                        disabled={ctx.busy}
                    />
                    <Button
                        label={t("set.pipeline_close")}
                        class={"secondary"}
                        disabled={ctx.busy}
                        onclick={closeEditor}
                    />
                </div>
            </Form>
        ) : (
            <Actions>
                <Button
                    label={t("set.pipeline_new")}
                    class={"secondary"}
                    disabled={ctx.busy}
                    onclick={openNewPipeline}
                />
            </Actions>
        );
        const pipelinesChildren: m.Children[] = [
            <p class={"muted"}>{t("set.pipelines_desc")}</p>,
            ...pipelineRows,
            editorElement,
        ];
        // Two cards of the module's own (selfCards): repositories and
        // pipelines. Card passes its children unchanged inside <section>, so
        // the flat arrays built above can be used as-is.
        return [
            m(Card, { title: t("set.repos") }, repositoriesChildren),
            m(Card, { title: t("set.pipelines") }, pipelinesChildren),
        ];
    },
};

export default def;
