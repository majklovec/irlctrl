import { PIPELINES_DIR } from "../config";
import { ApiError, requireString } from "../params";
import {
    removePipelineRepository,
    syncPipelineRepository,
} from "../pipelineRepos";
import {
    createPipelineFile,
    deletePipelineFile,
    pipelinesByPrefix,
    readPipelineFile,
    updatePipelineFile,
} from "../pipelines";
import { saveState, state } from "../state";
import type { MethodContext, MethodMap } from "./shared";

export function pipelineMethods(
    context: Pick<MethodContext, "services">,
): MethodMap {
    const { encoderServices } = context.services;

    /**
     * Fresh pipeline list plus per-repository file counts, returned by every
     * pipeline mutation so the settings card can re-render from one payload.
     */
    async function pipelinesPayload() {
        const pipelines = await encoderServices.listPipelines();
        return {
            pipelines,
            repositoryCounts: pipelinesByPrefix(
                pipelines.map((p) => p.id),
                state.settings.pipelineRepositories ?? [],
            ),
        };
    }

    return {
        "pipelines.list": async () => ({
            dir: PIPELINES_DIR,
            ...(await pipelinesPayload()),
        }),

        "pipelines.get": async (p) => {
            const id = requireString(p, "id").trim();
            return { id, content: await readPipelineFile(id, PIPELINES_DIR) };
        },

        "pipelines.create": async (p) => {
            const id = requireString(p, "id").trim();
            await createPipelineFile(id, requireString(p, "content"), PIPELINES_DIR);
            return { id, ...(await pipelinesPayload()) };
        },

        "pipelines.update": async (p) => {
            const id = requireString(p, "id").trim();
            await updatePipelineFile(id, requireString(p, "content"), PIPELINES_DIR);
            return { id, ...(await pipelinesPayload()) };
        },

        "pipelines.delete": async (p) => {
            const id = requireString(p, "id").trim();
            await deletePipelineFile(id, PIPELINES_DIR);
            return { id, ...(await pipelinesPayload()) };
        },

        "pipelines.repositories.add": async (p) => {
            const repository = requireString(p, "repository").trim();
            const result = await syncPipelineRepository(repository, PIPELINES_DIR);
            const repositories = new Set(
                state.settings.pipelineRepositories ?? [],
            ).add(repository);
            state.settings = {
                ...state.settings,
                pipelineRepositories: [...repositories].sort(),
            };
            await saveState();
            return {
                repositories: state.settings.pipelineRepositories,
                result,
                ...(await pipelinesPayload()),
            };
        },

        "pipelines.repositories.remove": async (p) => {
            const repository = requireString(p, "repository").trim();
            await removePipelineRepository(repository, PIPELINES_DIR);
            const pipelineRepositories = (
                state.settings.pipelineRepositories ?? []
            ).filter((r) => r !== repository);
            state.settings = { ...state.settings, pipelineRepositories };
            await saveState();
            return {
                repositories: pipelineRepositories,
                ...(await pipelinesPayload()),
            };
        },

        "pipelines.repositories.update": async (p) => {
            const repository = requireString(p, "repository").trim();
            const repositories = state.settings.pipelineRepositories ?? [];
            if (!repositories.includes(repository))
                throw new ApiError(`Repository not configured: ${repository}`, 404);
            const result = await syncPipelineRepository(repository, PIPELINES_DIR);
            return { repositories, result, ...(await pipelinesPayload()) };
        },

        "pipelines.repositories.updateAll": async () => {
            const repositories = state.settings.pipelineRepositories ?? [];
            const results = [];
            for (const repository of repositories)
                results.push(
                    await syncPipelineRepository(repository, PIPELINES_DIR),
                );
            return { repositories, results, ...(await pipelinesPayload()) };
        },
    };
}
