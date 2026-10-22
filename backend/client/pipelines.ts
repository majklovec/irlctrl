/*
 * Pipeline file management: CRUD for the GStreamer pipeline files under
 * PIPELINES_DIR (settings page → pipelines.create / pipelines.update /
 * pipelines.delete / pipelines.get), plus the per-directory file counts the
 * repository manager shows (pipelines.list → repositories).
 *
 * A pipeline's id is its path relative to PIPELINES_DIR, e.g.
 * "generic/x264_superfast_720p" or "author/repo/name" for imported repos.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { ApiError } from "../../shared/params";

/** One path segment: letters, digits, dot, underscore, hyphen (no slashes inside). */
const PIPELINE_ID_RE = /^[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)*$/;
/** Pipeline files are GStreamer launch strings: elements joined by " ! ". */
export function validatePipelineContent(
    id: string,
    content: string,
): string {
    const text = content;
    if (!text.trim())
        throw new ApiError(`Pipeline content for ${id} is empty`);
    if (!text.includes("!"))
        throw new ApiError(
            `Pipeline ${id} does not look like a GStreamer pipeline (no "!" links)`,
        );
    return text;
}

/** PIPELINES_DIR/<id>, refusing ids that are not plain relative paths. */
export function pipelinePath(
    id: string,
    pipelinesDir: string,
): { root: string; path: string } {
    if (!PIPELINE_ID_RE.test(id))
        throw new ApiError(
            `Invalid pipeline id "${id}" — use a relative path like "group/name"`,
        );
    const root = resolve(pipelinesDir);
    const path = resolve(root, id);
    if (!path.startsWith(root + sep))
        throw new ApiError(`Invalid pipeline id: ${id}`);
    return { root, path };
}

/** The pipeline file's content; 404 when it does not exist. */
export async function readPipelineFile(
    id: string,
    pipelinesDir: string,
): Promise<string> {
    const { path } = pipelinePath(id, pipelinesDir);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile())
        throw new ApiError(`Pipeline not found: ${id}`, 404);
    return readFile(path, "utf8");
}

/** Create a new pipeline file; 409 when the id is already taken. */
export async function createPipelineFile(
    id: string,
    content: string,
    pipelinesDir: string,
): Promise<{ id: string }> {
    const { root, path } = pipelinePath(id, pipelinesDir);
    if (await stat(path).catch(() => null))
        throw new ApiError(`Pipeline already exists: ${id}`, 409);
    const text = validatePipelineContent(id, content);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
    return { id };
}

/** Overwrite an existing pipeline file; 404 when it does not exist. */
export async function updatePipelineFile(
    id: string,
    content: string,
    pipelinesDir: string,
): Promise<{ id: string }> {
    const { path } = pipelinePath(id, pipelinesDir);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile())
        throw new ApiError(`Pipeline not found: ${id}`, 404);
    const text = validatePipelineContent(id, content);
    await writeFile(path, text, "utf8");
    return { id };
}

/** Delete a pipeline file; 404 when it does not exist. */
export async function deletePipelineFile(
    id: string,
    pipelinesDir: string,
): Promise<{ id: string }> {
    const { path } = pipelinePath(id, pipelinesDir);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile())
        throw new ApiError(`Pipeline not found: ${id}`, 404);
    await rm(path);
    // Drop the now-empty directory chain (e.g. a repo's last pipeline).
    let dir = dirname(path);
    const root = resolve(pipelinesDir);
    while (dir !== root && dir.length > root.length) {
        const entries = await readdir(dir).catch(() => ["" as string]);
        if (entries.length) break;
        await rm(dir, { recursive: false }).catch(() => {});
        dir = dirname(dir);
    }
    return { id };
}

/**
 * File count under `dir` (recursive, dot entries skipped). 0 when the
 * directory is missing — a configured repository whose mirror was removed
 * still appears in the list with zero pipelines.
 */
export async function countPipelineFiles(dir: string): Promise<number> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    let files = 0;
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isFile()) files++;
        else if (entry.isDirectory())
            files += await countPipelineFiles(join(dir, entry.name));
    }
    return files;
}

/**
 * Which of the given `prefixes` ("owner/repo") each pipeline id belongs to,
 * as a `prefix → count` map with every prefix present (0 when none match).
 */
export function pipelinesByPrefix(
    ids: string[],
    prefixes: string[],
): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const prefix of prefixes) counts[prefix] = 0;
    for (const id of ids) {
        for (const prefix of prefixes) {
            if (id === prefix || id.startsWith(prefix + "/")) {
                counts[prefix]++;
                break; // one pipeline, one repository
            }
        }
    }
    return counts;
}
