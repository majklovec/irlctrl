/** @jsx m */
/*
 * Asset library picker: a modal listing the user's media files from the
 * server-side asset manager (GET /api/assets/browse). Overlay elements
 * REUSE an already-uploaded file by referencing its id — image/video take
 * an `image`/`video` file, alert elements take a media file and an
 * `audio` sting.
 * The list is flattened across the folder tree (folder path as a dimmed
 * subtitle). The result is cached per kind for the page's lifetime — the
 * library rarely changes while an editor session is open, and re-opening the
 * picker must not refetch (Mithril view functions are re-created per render,
 * so the cache is module-scoped, like the field pickers in fields.tsx).
 */

import { apiTry } from "@ui/api_client";
import { Modal } from "@ui/components/";
import { t } from "@ui/i18n";
import type { OverlayElement } from "@ui/overlay/element";
import m from "mithril";

/** Which element's picker is open (module scope: Mithril re-creates view
 * closures per render, so a view-local flag would reset on every redraw). */
const pickerOpen = new Set<string>();

export interface LibraryAsset {
	id: string;
	name: string;
	mimeType: string;
	/** Folder chain without the root folder ("" = directly in the root). */
	path: string;
}

type ListState =
	| { status: "loading" }
	| { status: "error" }
	| { status: "ready"; files: LibraryAsset[] };

const cache: Record<AssetKind, ListState | undefined> = {} as Record<
	AssetKind,
	ListState | undefined
>;

/** The media kinds the library browse endpoint serves. */
export type AssetKind = "image" | "video" | "audio";

/** Fetch (once) the library files of one kind. */
export async function loadLibraryFiles(kind: AssetKind): Promise<void> {
	if (cache[kind] !== undefined) return;
	cache[kind] = { status: "loading" };
	const body = await apiTry<{ files: LibraryAsset[] }>(
		`/api/assets/browse?kind=${kind}`,
	);
	cache[kind] =
		body && Array.isArray(body.files)
			? { status: "ready", files: body.files }
			: { status: "error" };
	m.redraw();
}

export interface assetLibraryPickerProps {
	kind: AssetKind;
	/** The file id currently selected on the element (highlighted). */
	selectedId: string;
	onPick: (file: LibraryAsset) => void;
	onClose: () => void;
}

/** The inspector field for a server-asset prop: a button showing the
 * picked file (opens the picker), and a clear action. Also preloads the
 * library list while the field is visible. `propKey` is the element prop
 * that stores the picked file id (default `libraryAssetId`; alert elements
 * use their `mediaAssetId`/`audioAssetId` props). */
export function libraryAssetField(
	element: OverlayElement,
	mutate: (fn: (el: OverlayElement) => void) => void,
	kind: AssetKind,
	propKey = "libraryAssetId",
): m.Vnode {
	const selectedId =
		typeof element.props[propKey] === "string"
			? (element.props[propKey] as string)
			: "";
	const openKey = `${element.id}:${propKey}`;
	const files = cache[kind]?.status === "ready" ? cache[kind]!.files : undefined;
	const selected = files?.find((f) => f.id === selectedId);
	// preload the list while the field is visible (a cached no-op after load)
	void loadLibraryFiles(kind);
	return (
		<>
			<span class="ov-field">
				<span class="ov-lbl">{t("overlay.library")}</span>
				<span class="ov-lib-field">
					<button
						type="button"
						class="ov-lib-pick"
						title={t("overlay.library_pick")}
						onclick={() => {
							pickerOpen.add(openKey);
							void loadLibraryFiles(kind);
							m.redraw();
						}}>
						{selected ? selected.name : t("overlay.library_pick")}
					</button>
					{selectedId ? (
						<button
							type="button"
							class="ov-lib-clear"
							title={t("overlay.library_clear")}
							aria-label={t("overlay.library_clear")}
							onclick={() =>
								mutate((el) => {
									el.props[propKey] = "";
								})
							}>
							×
						</button>
					) : null}
				</span>
			</span>
			{pickerOpen.has(openKey)
				? assetLibraryPicker({
						kind,
						selectedId,
						onPick: (f) =>
							mutate((el) => {
								el.props[propKey] = f.id;
							}),
						onClose: () => {
							pickerOpen.delete(openKey);
							m.redraw();
						},
					})
				: null}
		</>
	);
}

/** The picker modal. Mount it conditionally (a module-scoped flag decides). */
export function assetLibraryPicker({
	kind,
	selectedId,
	onPick,
	onClose,
}: assetLibraryPickerProps): m.Vnode {
	const state = cache[kind] ?? { status: "loading" as const };
	return (
		<Modal
			title={t("overlay.library")}
			class="ov-lib-modal"
			onClose={onClose}>
			<p class="ov-lib-hint">
				<a class="muted" href="/assets/" target="_blank" rel="noreferrer">
					{t("overlay.library_manage")}
				</a>
			</p>
			<div class="ov-lib-list">
				{state.status === "loading" ? (
					<p class="muted">{t("overlay.library_loading")}</p>
				) : state.status === "error" ? (
					<p class="muted">{t("overlay.library_error")}</p>
				) : state.files.length === 0 ? (
					<p class="muted">{t("overlay.library_empty")}</p>
				) : (
					state.files.map((f) => (
						<button
							key={f.id}
							type="button"
							class={
								f.id === selectedId
									? "ov-lib-row ov-lib-row-sel"
									: "ov-lib-row"
							}
							onclick={() => {
								onPick(f);
								onClose();
							}}>
							<span class="ov-lib-name">{f.name}</span>
							{f.path ? (
								<span class="ov-lib-path">{f.path}</span>
							) : null}
						</button>
					))
				)}
			</div>
		</Modal>
	);
}
