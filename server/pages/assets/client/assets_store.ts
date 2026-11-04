/*
 * Assets manager state + API. The tree is loaded lazily: the single root
 * comes with the page, and each folder's children arrive when the folder is
 * expanded. File lists are cached per folder (in-memory map) so re-selecting
 * a folder does not refetch; mutations invalidate the affected caches.
 *
 * Data contracts (mirrored in the backend store):
 *   Folder  { id, parentId, name, createdAt, hasChildren, fileCount }
 *   AssetFile { id, folderId, name, size, mimeType, createdAt, updatedAt }
 */
import type { IconName } from "@ui/components/icons";
import { ApiError, apiJson, isUnauthorized } from "@ui/api_client";
import { t } from "@ui/i18n";
import m from "mithril";

export interface FolderNode {
	id: string;
	parentId: string | null;
	name: string;
	createdAt: number;
	hasChildren: boolean;
	fileCount: number;
}

export interface AssetFile {
	id: string;
	folderId: string;
	name: string;
	size: number;
	mimeType: string;
	createdAt: number;
	updatedAt: number;
}

type FilesState =
	| { status: "loading" }
	| { status: "success"; files: AssetFile[] }
	| { status: "error"; error: string };

type ChildrenState = FolderNode[] | "loading" | "error";

type ModalState =
	| { kind: "newFolder"; parentId: string }
	| { kind: "renameFile"; file: AssetFile }
	| { kind: "renameFolder"; folder: FolderNode }
	| {
			kind: "move";
			moving:
				| { kind: "file"; file: AssetFile }
				| { kind: "folder"; folder: FolderNode };
			loading: boolean;
	  }
	| null;

/** `""` is the key of the root list (top-level children). */
const ROOT_KEY = "";

export const state = {
	ready: false,
	/** Expanded folder ids (the root counts as expanded via this set). */
	expanded: new Set<string>(),
	/** `""` → top-level folders; otherwise the folder id. */
	children: new Map<string, ChildrenState>(),
	selectedId: null as string | null,
	/** focusId drives the roving tabindex of the tree keyboard navigation. */
	focusId: null as string | null,
	files: new Map<string, FilesState>(),
	/** File-list cache keyed by folder id (survives folder re-selection). */
	fileCache: new Map<string, AssetFile[]>(),
	/** Folders over which a drag is currently hovering (drop highlight). */
	dropTarget: null as string | null,
	/** Browser files being dragged over the file panel (drop highlight). */
	filesOverPanel: false,
	/** The trash drop zone has a draggable asset over it (drop highlight). */
	trashOver: false,
	/** Number of in-flight upload parts. */
	uploading: 0,
	modal: null as ModalState,
	modalValue: "",
	modalFolders: null as FolderNode[] | null,
	/** The in-app item being dragged (tree node or file row), if any. */
	dragging: null as { kind: "folder" | "file"; id: string } | null,
	/** The file row currently being dragged (dimmed while dragging). */
	dragFileId: null as string | null,
	/** Inline file-rename input value + target. */
	renameValue: "",
	renamingFileId: null as string | null,
};

/** Human-readable byte size: "512 B", "3.2 KB", "120 MB", … */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = n;
	let unit = -1;
	do {
		value /= 1024;
		unit++;
	} while (value >= 1024 && unit < units.length - 1);
	return `${unit < 2 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Locale-formatted date + time of a ms timestamp. */
export function formatDateTime(ts: number): string {
	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(ts));
	} catch {
		return new Date(ts).toLocaleString();
	}
}

/** The icon shape name for a mime type (icons: shared/ui/components/icons). */
export function fileIcon(mimeType: string, name: string): IconName {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("video/")) return "view";
	if (mimeType.startsWith("audio/")) return "bell";
	if (
		mimeType.startsWith("text/") ||
		[
			"application/json",
			"application/xml",
			"application/javascript",
			"application/pdf",
		].includes(mimeType)
	)
		return "text";
	if (/\.(zip|tar|gz|rar|7z)$/.test(name)) return "copy";
	return "rectangle";
}

/** A node visible in the expanded tree, in display order (depth first).
 * The root itself is not a visible node — the tree shows what is inside it. */
export function visibleTree(): FolderNode[] {
	const out: FolderNode[] = [];
	const walk = (parentKey: string): void => {
		const kids = state.children.get(parentKey);
		if (!Array.isArray(kids)) return;
		for (const kid of kids) {
			out.push(kid);
			if (state.expanded.has(kid.id)) walk(kid.id);
		}
	};
	const root = rootFolder();
	if (root) walk(root.id);
	return out;
}

/** The single root folder (once loaded). The tree renders what is inside it. */
export const rootFolder = (): FolderNode | null => {
	const roots = state.children.get(ROOT_KEY);
	return Array.isArray(roots) ? (roots[0] ?? null) : null;
};

/** A folder loaded into the tree cache, if any. */
const findLoadedFolder = (id: string): FolderNode | null => {
	for (const c of state.children.values())
		if (Array.isArray(c))
			for (const f of c) if (f.id === id) return f;
	return null;
};

/** The folder currently on the keyboard focus line. */
export const focusedFolder = (): FolderNode | null =>
	state.focusId ? findLoadedFolder(state.focusId) : null;

/** The page registers its toast here so store-level failures surface. */
export const feedback = {
	onError: (message: string) => {
		console.error("assets:", message);
	},
};

const selectedFolder = (): FolderNode | null => {
	if (!state.selectedId) return null;
	for (const c of state.children.values())
		if (Array.isArray(c))
			for (const f of c) if (f.id === state.selectedId) return f;
	return null;
};

/** The session expired (or was never there): send the user back to login.
 * Returns true when a 401 was handled, so callers can bail out. */
function handleAuth(err: unknown): boolean {
	if (isUnauthorized(err)) {
		location.replace("/login");
		return true;
	}
	return false;
}

async function fetchChildren(
	parentId: string | null,
): Promise<FolderNode[] | null> {
	const key = parentId ?? ROOT_KEY;
	state.children.set(key, "loading");
	m.redraw();
	let body: { folders: FolderNode[] } | null = null;
	try {
		body = await apiJson<{ folders: FolderNode[] }>(
			`/api/assets/folders${parentId ? `?parent=${encodeURIComponent(parentId)}` : ""}`,
		);
	} catch (err) {
		if (handleAuth(err)) return null;
		console.error("GET /api/assets/folders:", err);
	}
	const kids = body?.folders ?? null;
	state.children.set(key, kids ?? "error");
	m.redraw();
	return kids;
}

/** Fetch children of `folder` on first expand. */
export async function expand(folder: FolderNode): Promise<void> {
	if (state.expanded.has(folder.id)) return;
	state.expanded.add(folder.id);
	m.redraw();
	await fetchChildren(folder.id);
}

export function collapse(folder: FolderNode): void {
	state.expanded.delete(folder.id);
	m.redraw();
}

export function toggleExpand(folder: FolderNode): void {
	if (state.expanded.has(folder.id)) collapse(folder);
	else void expand(folder);
}

/** Select a folder and show its files (from the cache when available). */
export function selectFolder(folder: FolderNode): void {
	state.selectedId = folder.id;
	state.focusId = folder.id;
	m.redraw();
	loadFiles(folder.id, { useCache: true });
}

/** Load (or cache-hit) the file list of `folderId`. */
export function loadFiles(
	folderId: string,
	{ useCache }: { useCache: boolean },
): void {
	if (useCache && state.fileCache.has(folderId)) {
		state.files.set(folderId, {
			status: "success",
			files: state.fileCache.get(folderId)!,
		});
		m.redraw();
		return;
	}
	state.files.set(folderId, { status: "loading" });
	m.redraw();
	void apiJson<{ files: AssetFile[] }>(
		`/api/assets/files?folderId=${encodeURIComponent(folderId)}`,
	)
		.then((body) => {
			if (body?.files) {
				state.fileCache.set(folderId, body.files);
				state.files.set(folderId, {
					status: "success",
					files: body.files,
				});
			} else
				state.files.set(folderId, {
					status: "error",
					error: t("assets.error"),
				});
			m.redraw();
		})
		.catch((err) => {
			if (handleAuth(err)) return;
			console.error("GET /api/assets/files:", err);
			state.files.set(folderId, {
				status: "error",
				error: t("assets.error"),
			});
			m.redraw();
		});
}

/** Drop the file-list cache and refetch (retry button, post-mutation). */
export function refreshFiles(folderId: string): void {
	state.fileCache.delete(folderId);
	loadFiles(folderId, { useCache: false });
}

/** Refetch the children of a parent whose list is known expanded/loaded. */
function invalidateChildren(parentId: string | null): void {
	const key = parentId ?? ROOT_KEY;
	if (parentId === null || state.expanded.has(parentId))
		void fetchChildren(parentId);
	else state.children.delete(key);
}

function notifyError(err: unknown): void {
	if (handleAuth(err)) return;
	feedback.onError(err instanceof Error ? err.message : String(err));
}

/** Mount: fetch the (single) root, then load its contents — the tree shows
 * the root's children and the file list defaults to the root itself. */
export async function init(): Promise<void> {
	const roots = await fetchChildren(null);
	const root = roots?.[0];
	if (root) {
		void expand(root);
		selectFolder(root);
	}
	state.ready = true;
	m.redraw();
}

/* ------------------------------------------------------------------ *
 *  Mutations
 * ------------------------------------------------------------------ */

export async function createFolder(
	parentId: string,
	name: string,
): Promise<boolean> {
	try {
		const body = await apiJson<{ folder: FolderNode }>(
			"/api/assets/folders",
			{ body: { parentId, name } },
		);
		invalidateChildren(parentId);
		// The created folder lands in the selected folder's file view only
		// as a tree entry — make sure it is visible.
		state.expanded.add(parentId);
		m.redraw();
		return true;
	} catch (err) {
		notifyError(err);
		return false;
	}
}

export async function renameFolder(
	folder: FolderNode,
	name: string,
): Promise<boolean> {
	try {
		await apiJson(`/api/assets/folders/${folder.id}`, {
			method: "PATCH",
			body: { name },
		});
		invalidateChildren(folder.parentId);
		return true;
	} catch (err) {
		notifyError(err);
		return false;
	}
}

export async function moveFolder(
	folder: FolderNode,
	parentId: string,
): Promise<boolean> {
	try {
		await apiJson(`/api/assets/folders/${folder.id}`, {
			method: "PATCH",
			body: { parentId },
		});
		if (folder.parentId !== parentId)
			invalidateChildren(folder.parentId);
		invalidateChildren(parentId);
		return true;
	} catch (err) {
		notifyError(err);
		return false;
	}
}

export async function deleteFolder(folder: FolderNode): Promise<boolean> {
	try {
		await apiJson(`/api/assets/folders/${folder.id}`, {
			method: "DELETE",
		});
		invalidateChildren(folder.parentId);
		state.fileCache.delete(folder.id);
		state.files.delete(folder.id);
		state.expanded.delete(folder.id);
		if (state.selectedId === folder.id) {
			// Re-select the parent; deleting a top-level folder returns the
			// view to the (implicit) root.
			const parent = folder.parentId
				? findLoadedFolder(folder.parentId)
				: null;
			if (parent) selectFolder(parent);
			else state.selectedId = null;
		}
		m.redraw();
		return true;
	} catch (err) {
		notifyError(err);
		return false;
	}
}

/** Multipart upload of one or more browser files into `folderId`. */
export async function uploadFiles(
	folderId: string,
	files: File[],
): Promise<boolean> {
	const form = new FormData();
	form.append("folderId", folderId);
	for (const file of files) form.append("files", file, file.name);
	state.uploading += files.length;
	m.redraw();
	try {
		const res = await fetch("/api/assets/files", {
			method: "POST",
			body: form,
			cache: "no-store",
		});
		const body = (await res.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
			code?: number;
			files?: AssetFile[];
		} | null;
		if (!res.ok || body?.ok === false || !body?.files)
			throw new ApiError(
				body?.error ?? `HTTP ${res.status}`,
				res.status,
				body?.code,
				body,
			);
		state.fileCache.delete(folderId);
		state.files.delete(folderId);
		loadFiles(folderId, { useCache: false });
		return true;
	} catch (err) {
		notifyError(err);
		return false;
	} finally {
		state.uploading -= files.length;
		m.redraw();
	}
}

export async function renameFile(
	file: AssetFile,
	name: string,
): Promise<boolean> {
	try {
		await apiJson(`/api/assets/files/${file.id}`, {
			method: "PATCH",
			body: { name },
		});
		refreshFiles(file.folderId);
		return true;
	} catch (err) {
		notifyError(err);
		return false;
	}
}

export async function moveFile(
	file: AssetFile,
	folderId: string,
): Promise<boolean> {
	try {
		await apiJson(`/api/assets/files/${file.id}`, {
			method: "PATCH",
			body: { folderId },
		});
		// The old folder's list (if it is the selected one) and the new one
		// both need fresh data.
		if (state.selectedId === file.folderId)
			refreshFiles(file.folderId);
		if (state.selectedId === folderId) refreshFiles(folderId);
		state.fileCache.delete(folderId);
		state.fileCache.delete(file.folderId);
		return true;
	} catch (err) {
		notifyError(err);
		return false;
	}
}

export async function deleteFile(file: AssetFile): Promise<boolean> {
	try {
		await apiJson(`/api/assets/files/${file.id}`, {
			method: "DELETE",
		});
		refreshFiles(file.folderId);
		return true;
	} catch (err) {
		notifyError(err);
		return false;
	}
}

/* ------------------------------------------------------------------ *
 *  Move-target picker (modal)
 * ------------------------------------------------------------------ */

/** Every folder of the user, minus `excluded` and its descendants. */
export async function loadMoveTargets(
	excludedId: string | null,
): Promise<FolderNode[]> {
	state.modalFolders = null;
	m.redraw();
	let body: { folders: FolderNode[] } | null = null;
	try {
		body = await apiJson<{ folders: FolderNode[] }>(
			"/api/assets/folders/all",
		);
	} catch (err) {
		if (handleAuth(err)) return [];
		console.error("GET /api/assets/folders/all:", err);
	}
	const all = body?.folders ?? [];
	if (!excludedId) {
		state.modalFolders = all;
		m.redraw();
		return all;
	}
	const blocked = new Set<string>([excludedId]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const f of all)
			if (
				f.parentId &&
				blocked.has(f.parentId) &&
				!blocked.has(f.id)
			) {
				blocked.add(f.id);
				grew = true;
			}
	}
	state.modalFolders = all.filter((f) => !blocked.has(f.id));
	m.redraw();
	return state.modalFolders;
}

/** The currently selected folder object. */
export const selectedFolderNode = selectedFolder;
