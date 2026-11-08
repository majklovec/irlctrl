import {
	Button,
	Card,
	EmptyState,
	IconButton,
	IconLink,
	Page,
	RowActions,
	Table,
	Toolbar,
	Toast,
	useToast,
} from "@ui/components/";
import { confirmDialog } from "@ui/components/confirm";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { mountPage } from "@ui/util";
import m from "mithril";
import { ServerNav } from "../../../shell/nav";
import {
	copyOverlayUrl,
	createOverlay,
	deleteOverlay,
	duplicateOverlay,
	editorUrl,
	exportOverlay,
	importOverlay,
	load,
	renameOverlay,
	runtimeUrl,
	state,
} from "./overlay_store";

const toast = useToast();

/** Import an exported overlay file (the hidden input's selection is read
 * here; re-selecting the same file re-triggers `onchange` because the
 * input's value is reset). */
async function onImportFile(input: HTMLInputElement): Promise<void> {
	const file = input.files?.[0];
	input.value = "";
	if (!file) return;
	let raw: unknown;
	try {
		raw = JSON.parse(await file.text());
	} catch {
		toast.show(t("overlay.import_invalid_file"));
		return;
	}
	const error = await importOverlay(raw);
	if (error) toast.show(error);
}

export function listToolbar(): m.Vnode {
	return (
		<Toolbar label={t("overlay.new_overlay")}>
			<input
				type="text"
				placeholder={t("overlay.overlay_name")}
				value={state.newOverlayName}
				oninput={(ev: Event) => {
					state.newOverlayName = (ev.target as HTMLInputElement).value;
					m.redraw();
				}}
			/>
			<Button
				label={t("overlay.new_overlay")}
				disabled={!state.newOverlayName.trim()}
				title={
					state.newOverlayName.trim()
						? undefined
						: t("ui.enter_name_to_create")
				}
				onclick={() => void createOverlay()}
			/>
			<input
				type="file"
				hidden
				accept=".json,application/json"
				data-overlay-import
				onchange={(ev: Event) =>
					void onImportFile(ev.target as HTMLInputElement)
				}
			/>
			<Button
				label={t("overlay.import_overlay")}
				onclick={() =>
					document
						.querySelector<HTMLInputElement>("[data-overlay-import]")
						?.click()
				}
			/>
		</Toolbar>
	);
}

/** Inline rename control for an overlay row (Enter / blur commit, Escape
 * cancels). */
function renameInput(overlayId: string): m.Vnode {
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
					state.renamingOverlayId = null;
					m.redraw();
				}
			}}
			onblur={() => {
				void renameOverlay(overlayId, state.renameValue);
				state.renamingOverlayId = null;
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

/** Dashboards-style list of a user's overlays; click a name to open its
 * editor. */
export function overlayList(): m.Vnode {
	const overlays = state.overlays;
	return (
		<Card>
			{overlays.length ? (
				[
					<Table columns={[{ key: "name", header: t("overlay.name") }]}>
						{overlays.map((s) => (
							<tr key={s.id}>
								<td class="dash-name">
									{state.renamingOverlayId === s.id ? (
										renameInput(s.id)
									) : (
										<a class="dash-row-link" href={editorUrl(s.id)}>
											{s.name}
										</a>
									)}
								</td>

								<RowActions>
									<IconButton
										class={
											state.copiedOverlayId === s.id ? "ov-copied" : undefined
										}
										label={
											state.copiedOverlayId === s.id
												? t("overlay.copied")
												: t("overlay.copy")
										}
										icon={<Icon name="copy" class="role-icon" />}
										onclick={() => void copyOverlayUrl(s.id)}
									/>
									<IconLink
										href={runtimeUrl(s.id)}
										label={t("overlay.open")}
										icon={<Icon name="view" class="role-icon" />}
									/>
									<IconButton
										label={t("overlay.duplicate_overlay")}
										icon={<Icon name="copy" class="role-icon" />}
										onclick={() => void duplicateOverlay(s.id)}
									/>
									<IconButton
										label={t("overlay.export_overlay")}
										icon={<Icon name="download" class="role-icon" />}
										onclick={() => exportOverlay(s.id)}
									/>
									<IconButton
										label={t("overlay.rename_overlay")}
										icon={<Icon name="edit" class="role-icon" />}
										onclick={() => {
											state.renamingOverlayId = s.id;
											state.renameValue = s.name;
											m.redraw();
										}}
									/>
									<IconButton
										danger
										label={t("overlay.delete_overlay")}
										icon={<Icon name="delete" class="role-icon" />}
										onclick={async () => {
											if (
												await confirmDialog(
													t("overlay.confirm_delete_overlay"),
													{
														danger: true,
													},
												)
											)
												void deleteOverlay(s.id);
										}}
									/>
								</RowActions>
							</tr>
						))}
					</Table>,
					listToolbar(),
				]
			) : (
				<EmptyState message={t("overlay.empty_overlays")}>
					{listToolbar()}
				</EmptyState>
			)}
		</Card>
	);
}

const overlayListPage: m.Component = {
	oncreate() {
		void load();
	},
	view: () => (
		<Page nav={<ServerNav active="overlays" />}>
			{state.loaded ? (
				overlayList()
			) : (
				<p class="muted">{t("overlay.loading")}</p>
			)}
			<Toast message={toast.message} />
		</Page>
	),
};

void mountPage(() => t("overlay.title"), overlayListPage);
