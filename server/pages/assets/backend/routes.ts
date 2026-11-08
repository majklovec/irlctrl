/*
 * Assets manager routes:
 *   GET  /assets/                 the assets manager page (cookie auth)
 *   GET  /api/assets/folders      the child folders (?parent=<id>, no param =
 *                                 the root list) (cookie auth)
 *   GET  /api/assets/folders/all  every folder of the user (cookie auth)
 *   POST /api/assets/folders      {parentId, name} (cookie auth)
 *   PATCH /api/assets/folders/:id {name} | {parentId} (cookie auth)
 *   DELETE /api/assets/folders/:id (cookie auth)
 *   GET  /api/assets/files        the files of a folder (?folderId=<id>)
 *   GET  /api/assets/browse       the media files across the whole tree
 *                                 (?kind=image|video|audio, picker lists)
 *   POST /api/assets/files        multipart upload: `folderId` field plus one
 *                                 or more `files` parts (cookie auth)
 *   GET  /api/assets/file-meta/:id a file's metadata (no bytes)
 *   GET  /api/assets/files/:id    the file bytes (attachment download)
 *   PATCH /api/assets/files/:id   {name} | {folderId} (cookie auth)
 *   DELETE /api/assets/files/:id
 *
 * Everything is owner-scoped in the store — a user only touches their own
 * folders and files.
 */
import { Elysia } from "elysia";
import { ApiError } from "../../../../shared/params";
import type {
    PageServices,
    ProjectAccess,
    ProjectRole,
} from "../../../core/contracts";
import { scopedProject } from "../../../core/project_scope";
import { authenticatedHandler } from "../../../core/auth/authenticated";
import type { Assets, AssetFile, AssetFolder } from "./registry";

const FOLDER_ID_RE = /^\/api\/assets\/folders\/([\w-]{1,64})$/;
const FILE_ID_RE = /^\/api\/assets\/files\/([\w-]{1,64})$/;

/** Run `fn` and map its outcome: ApiError → `{ok:false, error, code}`. */
function run(
    fn: () =>
        | { status?: number; body: Record<string, unknown> }
        | Promise<{ status?: number; body: Record<string, unknown> }>,
): Promise<Response> {
    return (async (): Promise<Response> => {
        try {
            const result = await fn();
            return Response.json(result.body, {
                status: result.status ?? 200,
            });
        } catch (err: unknown) {
            const code = err instanceof ApiError ? err.code : 500;
            return Response.json(
                {
                    ok: false,
                    error:
                        err instanceof Error
                            ? err.message
                            : "Internal error",
                    code,
                },
                { status: code },
            );
        }
    })();
}

const json = (body: Record<string, unknown>): Response =>
    Response.json(body);

/** A folder row straight from the store, for list responses. */
const folderOut = (f: AssetFolder): Record<string, unknown> => ({ ...f });
const fileOut = (f: AssetFile): Record<string, unknown> => ({ ...f });

/** Read assets of any project the request's user can see; edits need editor+. */
const READ_ROLES = ["viewer", "editor", "owner"] as const;
const EDIT_ROLES = ["editor", "owner"] as const;

export function mountAssetRoutes(
    routes: Elysia,
    s: PageServices,
    assets: Assets,
): void {
    const { auth, capabilities, frontend } = s;
    const access = capabilities.require<ProjectAccess>("projectAccess");
    /** Resolve the request's project (`?project=` else Personal) + enforce roles. */
    const proj = (
        request: Request,
        user: string,
        roles: readonly ProjectRole[],
    ): string => scopedProject(access, new URL(request.url), user, roles);
    routes
        .get(
            "/assets/",
            authenticatedHandler(auth, () =>
                frontend.htmlResponse("assets_list"),
            ),
        )
        .get(
            "/api/assets/folders",
            authenticatedHandler(auth, (request, user) => {
                const parent = new URL(request.url).searchParams.get("parent");
                return run(() => ({
                    body: {
                        folders: assets.listFolders(proj(request, user, READ_ROLES), parent),
                    },
                }));
            }),
        )
        .get(
            "/api/assets/folders/all",
            authenticatedHandler(auth, (request, user) =>
                run(() => ({
                    body: {
                        folders: assets.allFolders(proj(request, user, READ_ROLES)),
                    },
                })),
            ),
        )
        .post(
            "/api/assets/folders",
            authenticatedHandler(auth, async (request, user) => {
                const body = (await request.json().catch(() => null)) as {
                    parentId?: unknown;
                    name?: unknown;
                } | null;
                const parentId =
                    typeof body?.parentId === "string" ? body.parentId : "";
                if (!parentId) throw new ApiError("parentId is required");
                return run(() => ({
                    body: {
                        folder: assets.createFolder(
                            proj(request, user, EDIT_ROLES),
                            parentId,
                            typeof body?.name === "string" ? body.name : "",
                        ),
                    },
                }));
            }),
        )
        .patch(
            "/api/assets/folders/*",
            authenticatedHandler(auth, async (request, user) => {
                const match = new URL(request.url).pathname.match(FOLDER_ID_RE);
                if (!match) return json({ ok: false, error: "Not found", code: 404 });
                const body = (await request.json().catch(() => null)) as {
                    name?: unknown;
                    parentId?: unknown;
                } | null;
                return run(() => {
                    let folder: AssetFolder;
                    if (typeof body?.parentId === "string")
                        folder = assets.moveFolder(
                            proj(request, user, EDIT_ROLES),
                            match[1],
                            body.parentId,
                        );
                    else if (typeof body?.name === "string")
                        folder = assets.renameFolder(
                            proj(request, user, EDIT_ROLES),
                            match[1],
                            body.name,
                        );
                    else
                        throw new ApiError(
                            "Provide {name} to rename or {parentId} to move",
                        );
                    return { body: { folder } };
                });
            }),
        )
        .delete(
            "/api/assets/folders/*",
            authenticatedHandler(auth, (request, user) => {
                const match = new URL(request.url).pathname.match(FOLDER_ID_RE);
                if (!match) return json({ ok: false, error: "Not found", code: 404 });
                return run(() => {
                    assets.deleteFolder(proj(request, user, EDIT_ROLES), match[1]);
                    return { body: { ok: true } };
                });
            }),
        )
        .get(
            "/api/assets/file-meta/*",
            authenticatedHandler(auth, (request, user) => {
                const match = new URL(request.url).pathname.match(
                    /^\/api\/assets\/file-meta\/([\w-]{1,64})$/,
                );
                if (!match)
                    return json({ ok: false, error: "Not found", code: 404 });
                return run(() => ({
                    body: { file: assets.fileMeta(proj(request, user, READ_ROLES), match[1]) },
                }));
            }),
        )
        .get(
            "/api/assets/files",
            authenticatedHandler(auth, (request, user) => {
                const folderId =
                    new URL(request.url).searchParams.get("folderId") ?? "";
                return run(() => ({
                    body: {
                        files: assets.listFiles(proj(request, user, READ_ROLES), folderId),
                    },
                }));
            }),
        )
        .get(
            "/api/assets/browse",
            authenticatedHandler(auth, (request, user) => {
                // The overlay editor's asset picker: the user's media files
                // flattened across the whole tree, with their folder path.
                const kind = new URL(request.url).searchParams.get("kind") ?? "";
                return run(() => {
                    if (!["image", "video", "audio"].includes(kind))
                        throw new ApiError(
                            "kind must be one of image, video, audio",
                        );
                    return {
                        body: {
                            files: assets.browseFiles(
                                proj(request, user, READ_ROLES),
                                kind as "image" | "video" | "audio",
                            ),
                        },
                    };
                });
            }),
        )
        .post(
            "/api/assets/files",
            authenticatedHandler(auth, async (request, user) => {
                const form = await request.formData().catch(() => {
                    throw new ApiError("Expected a multipart form body");
                });
                const folderId = form.get("folderId");
                if (typeof folderId !== "string" || !folderId)
                    throw new ApiError("folderId is required");
                const uploads = form.getAll("files").filter((f): f is File =>
                    f instanceof File,
                );
                if (!uploads.length)
                    throw new ApiError("No files to upload");
                const created: AssetFile[] = [];
                for (const part of uploads)
                    created.push(
                        assets.uploadFile(
                            proj(request, user, EDIT_ROLES),
                            folderId,
                            part.name,
                            part.type,
                            new Uint8Array(await part.arrayBuffer()),
                        ),
                    );
                return json({ files: created.map(fileOut) });
            }),
        )
        .get(
            "/api/assets/files/*",
            authenticatedHandler(auth, (request, user) => {
                const match = new URL(request.url).pathname.match(FILE_ID_RE);
                if (!match) return json({ ok: false, error: "Not found", code: 404 });
                try {
                    const { file, data } = assets.fileBlob(proj(request, user, READ_ROLES), match[1]);
                    // `filename*` carries the UTF-8 name (RFC 5987); the
                    // plain `filename` is an ASCII fallback for old clients.
                    const asciiName = file.name.replace(/[^\x20-\x7e]/g, "_");
                    return new Response(data as BodyInit, {
                        status: 200,
                        headers: {
                            "content-type": file.mimeType,
                            "content-length": String(file.size),
                            "content-disposition": `attachment; filename="${asciiName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
                            "cache-control": "no-store",
                        },
                    });
                } catch (err: unknown) {
                    const code = err instanceof ApiError ? err.code : 500;
                    return Response.json(
                        {
                            ok: false,
                            error:
                                err instanceof Error
                                    ? err.message
                                    : "Internal error",
                            code,
                        },
                        { status: code },
                    );
                }
            }),
        )
        .patch(
            "/api/assets/files/*",
            authenticatedHandler(auth, async (request, user) => {
                const match = new URL(request.url).pathname.match(FILE_ID_RE);
                if (!match) return json({ ok: false, error: "Not found", code: 404 });
                const body = (await request.json().catch(() => null)) as {
                    name?: unknown;
                    folderId?: unknown;
                } | null;
                return run(() => {
                    let file: AssetFile;
                    if (typeof body?.folderId === "string")
                        file = assets.moveFile(
                            proj(request, user, EDIT_ROLES),
                            match[1],
                            body.folderId,
                        );
                    else if (typeof body?.name === "string")
                        file = assets.renameFile(
                            proj(request, user, EDIT_ROLES),
                            match[1],
                            body.name,
                        );
                    else
                        throw new ApiError(
                            "Provide {name} to rename or {folderId} to move",
                        );
                    return { body: { file } };
                });
            }),
        )
        .delete(
            "/api/assets/files/*",
            authenticatedHandler(auth, (request, user) => {
                const match = new URL(request.url).pathname.match(FILE_ID_RE);
                if (!match) return json({ ok: false, error: "Not found", code: 404 });
                return run(() => {
                    assets.deleteFile(proj(request, user, EDIT_ROLES), match[1]);
                    return { body: { ok: true } };
                });
            }),
        );
}
