/*
 * Assets manager: the control server's file storage. A lazy folder tree on
 * the left (children load on first expand, single root), the files of the
 * selected folder on the right. Files and folders upload (button or
 * drag-and-drop of browser files) and rename; folders and files move by
 * dragging onto a tree node (or the file panel) and are deleted by dragging
 * them onto the trash icon in the files toolbar. The tree is keyboard
 * navigable (arrows + Enter); file rows carry per-row actions.
 */
import {
	Button,
	Card,
	EmptyState,
	IconButton,
	IconLink,
	Modal,
	Page,
	RowActions,
	Table,
	Toast,
	Toolbar,
	useToast,
} from "@ui/components/";
import { ServerNav } from "../../../shell/nav";
import { confirmDialog } from "@ui/components/confirm";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { mountPage } from "@ui/util";
import m from "mithril";
import {
	type AssetFile,
	collapse,
	createFolder,
	deleteFile,
	deleteFolder,
	expand,
	type FolderNode,
	feedback,
	fileIcon,
	formatBytes,
	formatDateTime,
	init,
	loadFiles,
	moveFile,
	moveFolder,
	renameFile,
	renameFolder,
	rootFolder,
	selectedFolderNode,
	selectFolder,
	state,
	toggleExpand,
	uploadFiles,
	visibleTree,
} from "./assets_store";

/** DnD mime types for the in-app moves (browser files use the "Files" type). */
const DND_FOLDER = "application/x-asset-folder";
const DND_FILE = "application/x-asset-file";

const toast = useToast();

/** The "can't drop on own subtree" toast may show at most once per drag. */
let blockedDropToastShown = false;

/* ------------------------------------------------------------------ *
 *  Folder tree
 * ------------------------------------------------------------------ */

function focusNode(id: string): void {
	const el = document.querySelector<HTMLElement>(`[data-asset-node="${id}"]`);
	el?.focus({ preventScroll: true });
	el?.scrollIntoView({ block: "nearest" });
}

function treeNode(folder: FolderNode): m.Vnode {
	const isExpanded = state.expanded.has(folder.id);
	const isSelected = state.selectedId === folder.id;
	const isFocus = state.focusId === folder.id;
	const isDropTarget = state.dropTarget === folder.id;
	const drag = state.dragging;
	// The dragged folder moves into the target folder. Moving up (onto an
	// ancestor, a sibling, …) is fine; it is blocked only onto itself, its
	// direct parent (a no-op) and onto a folder inside its own subtree
	// (that would create a cycle).
	const dragNode = drag?.kind === "folder" ? findFolder(drag.id) : undefined;
	const dropBlocked =
		!!drag &&
		drag.kind === "folder" &&
		(drag.id === folder.id ||
			folder.id === dragNode?.parentId ||
			(dragNode !== undefined && descendantIds(dragNode).has(folder.id)));

	const keyNav = (ev: KeyboardEvent): void => {
		const nodes = visibleTree();
		const index = nodes.findIndex((n) => n.id === folder.id);
		switch (ev.key) {
			case "ArrowDown": {
				const next = nodes[index + 1];
				if (next) {
					state.focusId = next.id;
					m.redraw();
					focusNode(next.id);
				}
				ev.preventDefault();
				break;
			}
			case "ArrowUp": {
				const prev = index > 0 ? nodes[index - 1] : undefined;
				if (prev) {
					state.focusId = prev.id;
					m.redraw();
					focusNode(prev.id);
				}
				ev.preventDefault();
				break;
			}
			case "ArrowRight":
				ev.preventDefault();
				if (!folder.hasChildren) break;
				if (!isExpanded) void expand(folder);
				else {
					const first = state.children.get(folder.id);
					if (Array.isArray(first) && first.length) {
						state.focusId = first[0].id;
						m.redraw();
						focusNode(first[0].id);
					}
				}
				break;
			case "ArrowLeft":
				ev.preventDefault();
				if (isExpanded) collapse(folder);
				// The root is not a visible node: top-level folders are the
				// leftmost edge of the tree.
				else if (folder.parentId && folder.parentId !== rootFolder()?.id) {
					state.focusId = folder.parentId;
					m.redraw();
					focusNode(folder.parentId);
				}
				break;
			case "Enter":
			case " ":
				ev.preventDefault();
				selectFolder(folder);
				if (folder.hasChildren && !isExpanded) void expand(folder);
				break;
		}
	};

	const isDragSource =
		!!drag && drag.kind === "folder" && drag.id === folder.id;

	return (
		<div
			class={[
				"asset-tree-node",
				isSelected ? "selected" : "",
				isDropTarget && !dropBlocked ? "drop-target" : "",
				dropBlocked ? "drop-blocked" : "",
				isDragSource ? "dragging" : "",
			]
				.filter(Boolean)
				.join(" ")}
			data-asset-node={folder.id}
			role="treeitem"
			aria-level={String(treeLevel(folder.id))}
			style={{
				paddingLeft: `${0.4 + (treeLevel(folder.id) - 1) * 0.9}rem`,
			}}
			aria-selected={isSelected}
			aria-expanded={folder.hasChildren ? isExpanded : undefined}
			title={dropBlocked ? t("assets.move_would_cycle") : undefined}
			tabindex={isFocus ? 0 : -1}
			onkeydown={keyNav}
			onfocus={() => {
				state.focusId = folder.id;
			}}
			draggable
			ondragstart={(ev: DragEvent) => {
				const dt = ev.dataTransfer;
				dt?.setData(DND_FOLDER, folder.id);
				if (dt) dt.effectAllowed = "move";
				state.dragging = { kind: "folder", id: folder.id };
				blockedDropToastShown = false;
				m.redraw();
			}}
			ondragend={() => {
				state.dragging = null;
				state.dropTarget = null;
				m.redraw();
			}}
			ondragover={(ev: DragEvent) => {
				const types = Array.from(ev.dataTransfer?.types ?? []);
				const isFileDrag =
					types.includes("Files") ||
					types.includes("file") ||
					!!ev.dataTransfer?.files.length;
				const isAssetDrag =
					types.includes(DND_FOLDER) || types.includes(DND_FILE);
				if (isAssetDrag && dropBlocked) {
					// The drop is refused (cycle); keep the browser's no-drop
					// cursor and explain the reason once per drag.
					if (!blockedDropToastShown) {
						blockedDropToastShown = true;
						toast.show(t("assets.move_would_cycle"));
					}
					return;
				}
				if (isAssetDrag || isFileDrag) {
					ev.preventDefault();
					if (state.dropTarget !== folder.id) {
						state.dropTarget = folder.id;
						m.redraw();
					}
				}
			}}
			ondragleave={() => {
				if (state.dropTarget === folder.id) {
					state.dropTarget = null;
					m.redraw();
				}
			}}
			ondrop={async (ev: DragEvent) => {
				ev.preventDefault();
				const dt = ev.dataTransfer;
				const draggedFolder = dt?.getData(DND_FOLDER);
				const draggedFile = dt?.getData(DND_FILE);
				state.dropTarget = null;
				state.dragging = null;
				m.redraw();
				// The dragged folder moves into the (target) folder it is
				// dropped on — standard file-manager semantics.
				if (draggedFolder) {
					const dNode = findFolder(draggedFolder);
					if (dNode) await moveFolder(dNode, folder.id);
				}
				else if (draggedFile) await moveFileToFolder(draggedFile, folder.id);
				else if (dt?.files.length)
					await uploadFiles(folder.id, Array.from(dt.files));
			}}
			onclick={() => {
				selectFolder(folder);
				if (folder.hasChildren && !isExpanded) void expand(folder);
			}}
		>
			<button
				type="button"
				class={
					folder.hasChildren
						? `asset-chevron${isExpanded ? " open" : ""}`
						: "asset-chevron spacer"
				}
				aria-label={
					folder.hasChildren
						? isExpanded
							? undefined
							: t("assets.expand")
						: undefined
				}
				aria-expanded={folder.hasChildren ? isExpanded : undefined}
				tabindex={-1}
				onclick={(ev: Event) => {
					ev.stopPropagation();
					if (folder.hasChildren) toggleExpand(folder);
				}}
			>
				{folder.hasChildren ? <Icon name="chevron" class="role-icon" /> : null}
			</button>
			<span class="asset-tree-icon">
				<Icon name="folder" class="role-icon" />
			</span>
			<span class="asset-tree-name" title={folder.name}>
				{folder.name}
			</span>
			{folder.fileCount > 0 ? (
				<span class="asset-tree-count muted" title={t("assets.file_count")}>
					{folder.fileCount}
				</span>
			) : null}
			<span class="asset-tree-actions">
				{folder.parentId !== null
					? [
							<IconButton
								key="rename"
								label={t("assets.rename")}
								icon={<Icon name="edit" class="role-icon" />}
								onclick={(ev: Event) => {
									ev.stopPropagation();
									openRenameFolder(folder);
								}}
							/>,
						]
					: null}
			</span>
		</div>
	);
}

/** The 1-based level of a node in the visible tree. The invisible root is
 * not counted, so its children are level 1. */
function treeLevel(id: string): number {
	const byId = new Map<string, FolderNode>();
	for (const c of state.children.values())
		if (Array.isArray(c)) for (const f of c) byId.set(f.id, f);
	let level = 0;
	let cursor: FolderNode | undefined = byId.get(id);
	let guard = 0;
	while (cursor && cursor.parentId !== null && guard++ < 64) {
		level++;
		cursor = byId.get(cursor.parentId);
	}
	return Math.max(1, level);
}

function treeNodes(folder: FolderNode): m.Vnode[] {
	const out: m.Vnode[] = [treeNode(folder)];
	if (state.expanded.has(folder.id))
		out.push(...treeChildren(folder));
	return out;
}

/** A folder's expanded sub-tree: its children (or a loading placeholder). */
function treeChildren(folder: FolderNode): m.Vnode[] {
	const kids = state.children.get(folder.id);
	if (Array.isArray(kids)) return kids.flatMap((kid) => treeNodes(kid));
	// No `key` here: the surrounding tree nodes are unkeyed and Mithril
	// forbids mixing keyed and unkeyed vnodes in a fragment.
	return [
		<div
			class="asset-tree-kids"
			style={{
				paddingLeft: `${1.3 + (treeLevel(folder.id) - 1) * 0.9}rem`,
			}}
		>
			<span class="muted">{t("mgmt.loading")}</span>
		</div>,
	];
}

/** The tree shows the contents of the root — the root itself is not a node. */
function folderTree(): m.Vnode {
	const roots = state.children.get("");
	const root = Array.isArray(roots) ? (roots[0] ?? null) : null;
	const kids = root ? state.children.get(root.id) : undefined;
	return (
		<div role="tree" aria-label={t("assets.title")} class="asset-tree">
			{root ? (
				Array.isArray(kids) ? (
					kids.length ? (
						kids.map((folder) => treeNodes(folder))
					) : (
						<p class="muted">{t("assets.tree_empty")}</p>
					)
				) : kids === "loading" ? (
					<p class="muted">{t("mgmt.loading")}</p>
				) : (
					<p class="muted">{t("assets.error")}</p>
				)
			) : roots === "loading" ? (
				<p class="muted">{t("mgmt.loading")}</p>
			) : roots === "error" ? (
				<p class="muted">{t("assets.error")}</p>
			) : (
				<p class="muted">{t("assets.tree_empty")}</p>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ *
 *  File list
 * ------------------------------------------------------------------ */

/** Inline rename of a file row (Enter / blur commits, Escape cancels). */
function renameFileInput(file: AssetFile): m.Vnode {
	return (
		<input
			class="ov-rename"
			value={state.renameValue}
			oninput={(ev: Event) =>
				(state.renameValue = (ev.target as HTMLInputElement).value)
			}
			onkeydown={(ev: KeyboardEvent) => {
				if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
				if (ev.key === "Escape") {
					state.renamingFileId = null;
					m.redraw();
				}
			}}
			onblur={() => {
				void renameFile(file, state.renameValue);
				state.renamingFileId = null;
				m.redraw();
			}}
			oncreate={(v) => {
				const el = v.dom as HTMLInputElement;
				el.focus();
				el.select();
			}}
		/>
	);
}

function filesPanel(): m.Vnode {
	// No selection means "inside the root": its files are the default view,
	// and "New folder" / uploads target it.
	const folder = selectedFolderNode() ?? rootFolder();
	if (!folder)
		return (
			<Card class="asset-files-card">
				<EmptyState message={t("assets.select_folder")} />
			</Card>
		);
	const filesState = state.files.get(folder.id);
	return (
		<Card class="asset-files-card" title={t("assets.title")}>
			<input
				type="file"
				multiple
				hidden
				data-asset-upload
				onchange={(ev: Event) => {
					const input = ev.target as HTMLInputElement;
					const files = input.files ? Array.from(input.files) : [];
					input.value = "";
					if (files.length) void uploadFiles(folder.id, files);
				}}
			/>
			<Toolbar label={t("assets.files_in", { name: folder.name })}>
				<Button
					label={
						state.uploading > 0 ? t("assets.uploading") : t("assets.upload")
					}
					disabled={state.uploading > 0}
					onclick={() =>
						document
							.querySelector<HTMLInputElement>("[data-asset-upload]")
							?.click()
					}
				/>
				<Button
					label={t("assets.new_folder")}
					onclick={() => openNewFolder(folder.id)}
				/>
			</Toolbar>
			<div
				class={state.filesOverPanel ? "asset-dropzone over" : "asset-dropzone"}
				ondragover={(ev: DragEvent) => {
					const dt = ev.dataTransfer;
					const isFileDrag =
						Array.from(dt?.types ?? []).includes("Files") ||
						Array.from(dt?.types ?? []).includes("file") ||
						!!dt?.files.length;
					if (isFileDrag) {
						ev.preventDefault();
						state.filesOverPanel = true;
						m.redraw();
					}
				}}
				ondragleave={() => {
					state.filesOverPanel = false;
					m.redraw();
				}}
				ondrop={async (ev: DragEvent) => {
					ev.preventDefault();
					state.filesOverPanel = false;
					m.redraw();
					const files = ev.dataTransfer?.files;
					if (files?.length) await uploadFiles(folder.id, Array.from(files));
				}}
			>
				{filesState?.status === "loading" ? (
					<p class="muted">{t("overlay.loading")}</p>
				) : filesState?.status === "error" ? (
					<EmptyState message={filesState.error}>
						<Toolbar>
							<Button
								label={t("assets.retry")}
								onclick={() => loadFiles(folder.id, { useCache: false })}
							/>
						</Toolbar>
					</EmptyState>
				) : !filesState?.files.length ? (
					<EmptyState message={t("assets.empty_drop")} />
				) : (
					<Table
						columns={[
							{ key: "name", header: t("overlay.name") },
							{ key: "size", header: t("assets.size") },
							{
								key: "modified",
								header: t("assets.modified"),
							},
						]}
					>
						{filesState.files.map((file) => (
							<tr
								key={file.id}
								class={state.dragFileId === file.id ? "dragging" : undefined}
								draggable
								ondragstart={(ev: DragEvent) => {
									const dt = ev.dataTransfer;
									dt?.setData(DND_FILE, file.id);
									if (dt) dt.effectAllowed = "move";
									state.dragging = {
										kind: "file",
										id: file.id,
									};
									state.dragFileId = file.id;
									m.redraw();
								}}
								ondragend={() => {
									state.dragging = null;
									state.dragFileId = null;
									state.dropTarget = null;
									m.redraw();
								}}
							>
								<td class="dash-name">
									{state.renamingFileId === file.id
										? renameFileInput(file)
										: (
												<span class="asset-file-name">
													<span class="asset-file-icon">
														<Icon
															name={fileIcon(file.mimeType, file.name)}
															class="role-icon"
														/>
													</span>
													{file.name}
												</span>
											)}
								</td>
								<td class="muted">{formatBytes(file.size)}</td>
								<td class="muted">{formatDateTime(file.updatedAt)}</td>
								<RowActions>
									<IconLink
										href={`/api/assets/files/${file.id}`}
										label={t("assets.download")}
										icon={<Icon name="download" class="role-icon" />}
									/>
									<IconButton
										label={t("assets.rename")}
										icon={<Icon name="edit" class="role-icon" />}
										onclick={() => {
											state.renamingFileId = file.id;
											state.renameValue = file.name;
											m.redraw();
										}}
									/>
								</RowActions>
							</tr>
						))}
					</Table>
				)}
			</div>
		</Card>
	);
}

/** The floating trash drop zone (bottom-right corner of the page). */
function trashZone(): m.Vnode {
	return (
		<div
			class={[
				"asset-trash",
				state.dragging ? "armed" : "",
				state.trashOver ? "over" : "",
			]
				.filter(Boolean)
				.join(" ")}
			role="img"
			aria-label={t("assets.trash_drop")}
			title={t("assets.trash_drop")}
			ondragover={(ev: DragEvent) => {
				const types = Array.from(ev.dataTransfer?.types ?? []);
				if (types.includes(DND_FOLDER) || types.includes(DND_FILE)) {
					ev.preventDefault();
					if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
					if (!state.trashOver) {
						state.trashOver = true;
						m.redraw();
					}
				}
			}}
			ondragleave={() => {
				if (state.trashOver) {
					state.trashOver = false;
					m.redraw();
				}
			}}
			ondrop={(ev: DragEvent) => {
				ev.preventDefault();
				void trashDrop(ev);
			}}
		>
			<Icon name="delete" class="role-icon" />
		</div>
	);
}

/** A loaded folder node by id (the lazy tree keeps loaded levels here). */
function findFolder(id: string): FolderNode | undefined {
	for (const kids of state.children.values())
		if (Array.isArray(kids)) {
			const found = kids.find((k) => k.id === id);
			if (found) return found;
		}
	return undefined;
}

/** Loaded descendant ids of `folder` (DnD cycle guard). */
function descendantIds(folder: FolderNode): Set<string> {
	const out = new Set<string>();
	const queue: FolderNode[] = [folder];
	let guard = 0;
	while (queue.length && guard++ < 512) {
		const node = queue.shift()!;
		const kids = state.children.get(node.id);
		if (Array.isArray(kids))
			for (const k of kids) {
				out.add(k.id);
				queue.push(k);
			}
	}
	return out;
}

/** Drop a dragged folder/file on the trash: confirm, then delete. */
async function trashDrop(ev: DragEvent): Promise<void> {
	state.trashOver = false;
	const dt = ev.dataTransfer;
	const folderId = dt?.getData(DND_FOLDER);
	const fileId = dt?.getData(DND_FILE);
	if (folderId) {
		const folder = findFolder(folderId);
		if (
			folder &&
			(
				await confirmDialog(
					t("assets.confirm_delete_folder", { name: folder.name }),
					{ danger: true },
				)
			)
		)
			await deleteFolder(folder);
	} else if (fileId) {
		let file: AssetFile | undefined;
		for (const files of state.fileCache.values()) {
			file = files.find((f) => f.id === fileId);
			if (file) break;
		}
		if (
			file &&
			(
				await confirmDialog(t("assets.confirm_delete_file", { name: file.name }), {
					danger: true,
				})
			)
		)
			await deleteFile(file);
	}
}

/** Move a file known by id only (drag-and-drop payloads carry just the id):
 * look the row up in the loaded caches, then via the meta endpoint. */
async function moveFileToFolder(
	fileId: string,
	folderId: string,
): Promise<void> {
	for (const files of state.fileCache.values()) {
		const file = files.find((f) => f.id === fileId);
		if (file) {
			await moveFile(file, folderId);
			return;
		}
	}
	try {
		const res = await fetch(`/api/assets/file-meta/${fileId}`, {
			cache: "no-store",
		});
		if (res.ok) {
			const body = (await res.json()) as { file?: AssetFile };
			if (body.file) await moveFile(body.file, folderId);
		}
	} catch (err) {
		console.error("assets move:", err);
	}
}

/* ------------------------------------------------------------------ *
 *  Modals (new folder / rename folder / move picker)
 * ------------------------------------------------------------------ */

function openNewFolder(parentId: string): void {
	state.modal = { kind: "newFolder", parentId };
	state.modalValue = "";
	m.redraw();
}

function openRenameFolder(folder: FolderNode): void {
	state.modal = { kind: "renameFolder", folder };
	state.modalValue = folder.name;
	m.redraw();
}

async function submitNewFolder(): Promise<void> {
	const modal = state.modal;
	if (modal?.kind !== "newFolder") return;
	if (await createFolder(modal.parentId, state.modalValue)) {
		state.modal = null;
		m.redraw();
	}
}

async function submitRenameFolder(): Promise<void> {
	const modal = state.modal;
	if (modal?.kind !== "renameFolder") return;
	if (await renameFolder(modal.folder, state.modalValue)) {
		state.modal = null;
		m.redraw();
	}
}

function modalView(): m.Vnode | null {
	const modal = state.modal;
	if (!modal) return null;
	const close = () => {
		state.modal = null;
		m.redraw();
	};

	if (modal.kind === "newFolder")
		return (
			<Modal title={t("assets.new_folder")} onClose={close}>
				<label class="muted">
					{t("assets.folder_name")}
					<input
						class="ov-rename"
						value={state.modalValue}
						placeholder={t("assets.folder_name")}
						oninput={(ev: Event) =>
							(state.modalValue = (ev.target as HTMLInputElement).value)
						}
						onkeydown={(ev: KeyboardEvent) => {
							if (ev.key === "Enter") void submitNewFolder();
							if (ev.key === "Escape") close();
						}}
						oncreate={(v) => {
							const el = v.dom as HTMLInputElement;
							el.focus();
							el.select();
						}}
					/>
				</label>
				<div class="actions">
					<Button label={t("ui.cancel")} onclick={close} />
					<Button
						label={t("tpl.create")}
						disabled={!state.modalValue.trim()}
						onclick={() => void submitNewFolder()}
					/>
				</div>
			</Modal>
		);

	if (modal.kind === "renameFolder")
		return (
			<Modal title={t("assets.rename")} onClose={close}>
				<label class="muted">
					{t("assets.folder_name")}
					<input
						class="ov-rename"
						value={state.modalValue}
						oninput={(ev: Event) =>
							(state.modalValue = (ev.target as HTMLInputElement).value)
						}
						onkeydown={(ev: KeyboardEvent) => {
							if (ev.key === "Enter") void submitRenameFolder();
							if (ev.key === "Escape") close();
						}}
						oncreate={(v) => {
							const el = v.dom as HTMLInputElement;
							el.focus();
							el.select();
						}}
					/>
				</label>
				<div class="actions">
					<Button label={t("ui.cancel")} onclick={close} />
					<Button
						label={t("assets.save")}
						disabled={!state.modalValue.trim()}
						onclick={() => void submitRenameFolder()}
					/>
				</div>
			</Modal>
		);

	return null;
}

/* ------------------------------------------------------------------ *
 *  Page
 * ------------------------------------------------------------------ */

const assetsPage: m.Component = {
	oncreate() {
		// Route store-level failures to the page toast.
		feedback.onError = (message) => toast.show(message);
		void init();
	},
	view: () => (
		<Page nav={<ServerNav active="assets" />}>
			<div class="asset-layout">
				<Card class="asset-tree-card" title={t("assets.title")}>
					{state.ready ? (
						folderTree()
					) : (
						<p class="muted">{t("mgmt.loading")}</p>
					)}
				</Card>
				{filesPanel()}
			</div>
			{trashZone()}
			{modalView()}
			<Toast message={toast.message} />
		</Page>
	),
};

// Rescope to the newly selected project when the shell selector changes it.
window.addEventListener("project-changed", () => {
	void init();
});

void mountPage(() => t("assets.title"), assetsPage);
