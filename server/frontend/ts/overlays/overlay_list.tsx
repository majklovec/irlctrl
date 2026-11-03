import {
	Button,
	Card,
	EmptyState,
	IconButton,
	IconLink,
	Page,
	RowActions,
	ServerNav,
	Table,
	Toolbar,
} from "@ui/components/";
import { confirmDialog } from "@ui/components/confirm";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { mountPage } from "@ui/util";
import m from "mithril";
import {
	copySceneUrl,
	createScene,
	deleteScene,
	duplicateScene,
	editorUrl,
	load,
	renameScene,
	runtimeUrl,
	state,
} from "./overlay_store";

export function listToolbar(): m.Vnode {
	return (
		<Toolbar label={t("overlay.new_scene")}>
			<input
				type="text"
				placeholder={t("overlay.scene_name")}
				value={state.newSceneName}
				oninput={(ev: Event) => {
					state.newSceneName = (ev.target as HTMLInputElement).value;
					m.redraw();
				}}
			/>
			<Button
				label={t("overlay.new_scene")}
				disabled={!state.newSceneName.trim()}
				onclick={() => void createScene()}
			/>
		</Toolbar>
	);
}

/** Inline rename control for a scene row (Enter / blur commit, Escape cancels). */
function renameInput(sceneId: string): m.Vnode {
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
					state.renamingSceneId = null;
					m.redraw();
				}
			}}
			onblur={() => {
				void renameScene(sceneId, state.renameValue);
				state.renamingSceneId = null;
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

/** Dashboards-style list of overlays; click a scene name to open its editor. */
export function overlayList(): m.Vnode {
	const scenes = state.project.scenes;
	return (
		<Card>
			{scenes.length ? (
				[
					<Table
						columns={[
							{ key: "name", header: t("overlay.name") },
							{ key: "url", header: t("overlay.url") },
							{ key: "elements", header: t("overlay.elements") },
						]}
					>
						{scenes.map((s) => (
							<tr key={s.id}>
								<td class="dash-name">
									{state.renamingSceneId === s.id ? (
										renameInput(s.id)
									) : (
										<a class="dash-row-link" href={editorUrl(s.id)}>
											{s.name}
										</a>
									)}
								</td>
								<td class="ov-row-url">
									<a
										class="ov-row-url-text"
										href={runtimeUrl(s)}
										target="_blank"
										rel="noreferrer"
										title={runtimeUrl(s)}
									>
										{runtimeUrl(s)}
									</a>
									<IconButton
										class={
											state.copiedSceneId === s.id ? "ov-copied" : undefined
										}
										label={
											state.copiedSceneId === s.id
												? t("overlay.copied")
												: t("overlay.copy")
										}
										icon={<Icon name="copy" class="role-icon" />}
										onclick={() => void copySceneUrl(s)}
									/>
								</td>
								<td class="muted">{s.elements.length}</td>
								<RowActions>
									<IconLink
										href={editorUrl(s.id)}
										label={t("overlay.open")}
										icon={<Icon name="view" class="role-icon" />}
									/>
									<IconButton
										label={t("overlay.duplicate_scene")}
										icon={<Icon name="copy" class="role-icon" />}
										onclick={() => void duplicateScene(s.id)}
									/>
									<IconButton
										label={t("overlay.rename_scene")}
										icon={<Icon name="edit" class="role-icon" />}
										onclick={() => {
											state.renamingSceneId = s.id;
											state.renameValue = s.name;
											m.redraw();
										}}
									/>
									<IconButton
										danger
										label={t("overlay.delete_scene")}
										icon={<Icon name="delete" class="role-icon" />}
										onclick={async () => {
											if (
												await confirmDialog(t("overlay.confirm_delete_scene"), {
													danger: true,
												})
											)
												void deleteScene(s.id);
										}}
									/>
								</RowActions>
							</tr>
						))}
					</Table>,
					listToolbar(),
				]
			) : (
				<EmptyState message={t("overlay.empty_list")}>
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
		</Page>
	),
};

void mountPage(() => t("overlay.title"), overlayListPage);
