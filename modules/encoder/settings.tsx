/**
 * Encoder settings module: pipeline repositories and pipeline files.
 *
 * Visible for the encoder/combined roles, and for the custom role when the
 * server reports the encoder module as enabled. Default-exports its
 * ModuleDef; the settings framework registers it from the generated
 * manifest (generated/modules.settings.ts) — no per-module imports.
 *
 * One card, two sections:
 *  1. Pipeline repositories — add / update / remove GitHub mirrors, with a
 *     per-repository pipeline count.
 *  2. Pipeline files — list and delete the GStreamer launch strings under
 *     the pipelines directory; creating and editing open the dedicated
 *     pipeline editor page (/pipelines/…).
 */
import m from "mithril";
import { actionIcon, chevronIcon } from "../../frontend/ts/components/icons";
import {
    Actions,
    Badge,
    Break,
    Button,
    Card,
    Field,
    Form,
    Input,
} from "../../frontend/ts/components/ui";
import { t } from "../../frontend/ts/i18n";
import type { ModuleContext, ModuleDef } from "../../frontend/ts/modules";
import type { Pipeline } from "../../shared/types";
import "./styles.css";

const REPO_PATTERN = "[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+";

/** The payload every `pipelines.*` response carries. */
interface PipelinesPayload {
    pipelines: Pipeline[];
    repositoryCounts: Record<string, number>;
}

/** Editable copy; repositories/pipelines mirror the server's current state. */
const state = {
    repository: "",
    repositories: [] as string[],
    pipelines: [] as Pipeline[],
    counts: {} as Record<string, number>,
    // Group name → true when expanded. Groups default to folded.
    expandedGroups: {} as Record<string, boolean>,
};

// The dedicated pipeline editor lives one folder up from /settings/ in both
// the control server (/d/<id>/pipelines/…) and the device-local API
// (/pipelines/…), so a relative link works for both.
const PIPELINE_NEW_URL = "../pipelines/new/";
const pipelineEditUrl = (id: string) =>
    `../pipelines/edit/${encodeURIComponent(id)}/`;

// The device answering may run an older build whose payload lacks these
// fields; normalise so render never iterates a non-array (the dashboard's
// own pipelines.list consumer guards the same way).
function applyPayload(payload: Partial<PipelinesPayload> | undefined): void {
    state.pipelines = Array.isArray(payload?.pipelines)
        ? payload.pipelines
        : [];
    state.counts = payload?.repositoryCounts ?? {};
    m.redraw();
}

const repositoryList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((r) => typeof r === "string") : [];

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
            const payload =
                await ctx.rpc.call<PipelinesPayload>("pipelines.list");
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
    ctx.note(t("set.repo_importing", { repository }));
    const response = await ctx.run(() =>
        ctx.rpc.call<
            PipelinesPayload & {
                repositories: string[];
                result: { files: number };
            }
        >("pipelines.repositories.add", { repository }),
    );
    state.repositories = repositoryList(response.repositories);
    state.repository = "";
    loadSeq++;
    applyPayload(response);
    ctx.note(t("set.repo_imported", { files: response.result?.files ?? 0 }));
}

async function removeRepository(
    ctx: ModuleContext,
    repository: string,
): Promise<void> {
    ctx.note(t("set.repo_removing", { repository }));
    const response = await ctx.run(() =>
        ctx.rpc.call<PipelinesPayload & { repositories: string[] }>(
            "pipelines.repositories.remove",
            { repository },
        ),
    );
    state.repositories = repositoryList(response.repositories);
    loadSeq++;
    applyPayload(response);
    ctx.note(t("set.repo_removed", { repository }));
}

async function updateRepository(
    ctx: ModuleContext,
    repository: string,
): Promise<void> {
    ctx.note(t("set.repo_updating", { repository }));
    const response = await ctx.run(() =>
        ctx.rpc.call<PipelinesPayload & { result: { files: number } }>(
            "pipelines.repositories.update",
            { repository },
        ),
    );
    loadSeq++;
    applyPayload(response);
    ctx.note(
        t("set.repo_updated", {
            repository,
            files: response.result?.files ?? 0,
        }),
    );
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
    const results = Array.isArray(response.results) ? response.results : [];
    const files = results.reduce((total, r) => total + r.files, 0);
    ctx.note(
        t("set.repo_updated_all", {
            repositories: results.length,
            files,
        }),
    );
}

function toggleGroup(group: string): void {
    state.expandedGroups[group] = !state.expandedGroups[group];
    m.redraw();
}

async function deletePipeline(
    ctx: ModuleContext,
    pipeline: Pipeline,
): Promise<void> {
    if (!window.confirm(t("set.pipeline_delete_confirm", { id: pipeline.id })))
        return;
    const response = await ctx.run(() =>
        ctx.rpc.call<PipelinesPayload>("pipelines.delete", {
            id: pipeline.id,
        }),
    );
    loadSeq++;
    applyPayload(response);
    ctx.note(t("set.pipeline_deleted", { id: pipeline.id }));
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
        state.repositories = repositoryList(ctx.settings.pipelineRepositories);
        void loadPipelines(ctx);
    },
    render: (ctx) => {
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
                ? [<p class={"muted"}>{t("set.pipelines_none")}</p>]
                : [...groups.entries()].flatMap(
                      ([group, pipelines]): m.Children[] => {
                          const expanded = state.expandedGroups[group] === true;
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
                                      aria-label={
                                          t(
                                              expanded
                                                  ? "set.group_collapse"
                                                  : "set.group_expand",
                                          ) +
                                          " " +
                                          group
                                      }
                                      onclick={() => toggleGroup(group)}>
                                      {chevronIcon()}
                                      <span class={"pipe-group-name"}>
                                          {group}
                                      </span>
                                      <Badge
                                          text={t("set.pipeline_count", {
                                              count: pipelines.length,
                                          })}
                                      />
                                  </button>
                                  {expanded
                                      ? pipelines.map((pipeline) => (
                                            <div class={"pipeline-item"}>
                                                <code title={pipeline.id}>
                                                    {pipeline.name}
                                                </code>
                                                <div class={"dash-row-actions"}>
                                                    <a
                                                        href={pipelineEditUrl(
                                                            pipeline.id,
                                                        )}
                                                        class={"icon-link"}
                                                        title={t(
                                                            "set.pipeline_edit",
                                                        )}
                                                        aria-label={t(
                                                            "set.pipeline_edit",
                                                        )}>
                                                        {actionIcon("edit")}
                                                    </a>
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
                                                        disabled={ctx.busy}
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
                              text={t("set.pipeline_count", {
                                  count: state.counts[repository] ?? 0,
                              })}
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
            : [<p></p>];
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
        const addPipelineElement: m.Children = (
            <Actions>
                <a href={PIPELINE_NEW_URL} class={"link-button secondary"}>
                    {t("set.pipeline_new")}
                </a>
            </Actions>
        );
        const pipelinesChildren: m.Children[] = [
            <p class={"muted"}>{t("set.pipelines_desc")}</p>,
            ...pipelineRows,
            addPipelineElement,
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
