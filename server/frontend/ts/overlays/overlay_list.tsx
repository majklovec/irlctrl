import m from "mithril";
import { Icon } from "../../../../shared/ui/components/icons";
import {
	Button,
	Card,
	Page,
	ServerNav,
} from "../../../../shared/ui/components/ui";
import { confirmDialog } from "../../../../shared/ui/components/confirm";
import { t } from "../../../../shared/ui/i18n";
import { mountPage } from "../../../../shared/ui/util";
import {
	createScene,
	deleteScene,
	editorUrl,
	load,
	renameScene,
	state,
} from "./overlay_store";

export function listToolbar(): m.Vnode {
	return (
		<div class="dash-toolbar">
			<span class="dash-empty-text">{t("overlay.new_scene")}</span>
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
		</div>
	);
}

/** Dashboards-style list of overlays; click a row to open its editor. */
export function overlayList(): m.Vnode {
	const scenes = state.project.scenes;
	return (
		<Card>
			{scenes.length ? (
				[
					<table class="dash-table">
						<thead>
							<tr>
								<th>{t("overlay.name")}</th>
								<th>{t("overlay.url")}</th>
								<th>{t("overlay.elements")}</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{scenes.map((s) => (
								<tr key={s.id} onclick={() => location.assign(editorUrl(s.id))}>
									<td class="dash-name">
										{state.renamingSceneId === s.id ? (
											<input
												class="ov-rename"
												value={state.renameValue}
												oninput={(ev: Event) =>
													(state.renameValue = (
														ev.target as HTMLInputElement
													).value)
												}
												onkeydown={(ev: KeyboardEvent) => {
													if (ev.key === "Enter")
														(ev.target as HTMLInputElement).blur();
													if (ev.key === "Escape") {
														state.renamingSceneId = null;
														m.redraw();
													}
												}}
												onblur={() => {
													void renameScene(s.id, state.renameValue);
													state.renamingSceneId = null;
													m.redraw();
												}}
												oncreate={(v) => {
													const el = v.dom as HTMLInputElement;
													el.focus();
													el.select();
												}}
											/>
										) : (
											<span class="dash-row-link">{s.name}</span>
										)}
									</td>
									<td class="muted">/overlay/{s.slug}</td>
									<td class="muted">{s.elements.length}</td>
									<td class="actions-cell">
										<div class="dash-row-actions">
											{[
												<a
													class="icon-link"
													href={editorUrl(s.id)}
													title={t("overlay.open")}
													aria-label={t("overlay.open")}
													onclick={(ev: Event) => ev.stopPropagation()}
												>
													<Icon name="view" class="role-icon" />
												</a>,
												<Button
													label={<Icon name="edit" class="role-icon" />}
													class="icon-link"
													title={t("overlay.rename_scene")}
													aria-label={t("overlay.rename_scene")}
													onclick={(ev: Event) => {
														ev.stopPropagation();
														state.renamingSceneId = s.id;
														state.renameValue = s.name;
														m.redraw();
													}}
												/>,
												<Button
													label={<Icon name="delete" class="role-icon" />}
													class="icon-link dash-delete"
													title={t("overlay.delete_scene")}
													aria-label={t("overlay.delete_scene")}
													onclick={async (ev: Event) => {
														ev.stopPropagation();
														if (
															await confirmDialog(
																t("overlay.confirm_delete_scene"),
																{
																	danger: true,
																},
															)
														)
															void deleteScene(s.id);
													}}
												/>,
											]}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>,
					listToolbar(),
				]
			) : (
				<div class="dash-empty">
					<p class="muted">{t("overlay.empty_list")}</p>
					{listToolbar()}
				</div>
			)}
		</Card>
	);
}

const overlayListPage: m.Component = {
	oncreate() {
		void load();
	},
	view: () => (
		<Page title={t("overlay.title")} nav={<ServerNav active="overlays" />}>
			{state.loaded ? (
				overlayList()
			) : (
				<p class="muted">{t("overlay.loading")}</p>
			)}
		</Page>
	),
};

void mountPage(() => t("overlay.title"), overlayListPage);
