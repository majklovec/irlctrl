/** @jsx m */
/*
 * Inspector list editors for the overlay widgets whose props are lists of
 * small objects: the channel rows on the chat-driven widgets, and the
 * row-lists on socials, credits, tasks, counter and spin wheel.
 *
 * `ListField` is the generic one (a table of typed sub-fields + add/remove).
 * `ChannelsField` is a thin, channels-specific build on the same markup (each
 * row = a platform select + a handle input). Both mutate `props[key]` and
 * reuse the editor's `.ov-channel-*` classes (declared in overlay_editor.css)
 * so every list looks the same.
 */

import { Icon } from "@ui/components/icons";
import type { MithrilJSXComponent } from "@ui/jsx";
import { t } from "@ui/i18n";
import type { ElementProps, OverlayElement } from "@ui/overlay/element";
import type { Children, Vnode } from "mithril";
import m from "mithril";
import { CHAT_PLATFORMS, type ChatChannel } from "./live_chat_feed";

/** Platform option label keys — the names resolve once the merged catalog is
 * loaded (YouTube/Twitch/Kick/TikTok labels live with the chat module). */
const PLATFORM_LABEL_KEY: Record<string, string> = {
	youtube: "dash.widget_youtube",
	twitch: "dash.widget_twitch",
	tiktok: "dash.widget_tiktok",
	kick: "dash.widget_kick",
};
const platformLabel = (p: string): string =>
	t(PLATFORM_LABEL_KEY[p] ?? p);

/** The channels list for a chat-driven widget: pick a platform, type a
 * handle. Mutates `props.channels` (a normalized `ChatChannel[]`). */
export const ChannelsField = {
	view: (vnode: m.Vnode): Vnode => {
		// Mithril calls a component's `view` with the vnode — props live in attrs.
		const props = vnode.attrs as ElementProps;
	const element = props.element;
	const channels = (element.props.channels ?? []) as ChatChannel[];
	const set = (next: ChatChannel[]): void =>
		props.mutate((el) => {
			el.props.channels = next;
		});
	return (
		<div class="ov-field">
			<span class="ov-lbl">{t("overlay.chat_channels")}</span>
			<div class="ov-channels">
				{channels.length === 0 ? (
					<div class="ov-channels-empty">
						{t("overlay.chat_no_channels")}
					</div>
				) : (
					channels.map((c, i) => (
						<div class="ov-channel-row" key={i}>
							<select
								value={c.platform}
								aria-label={t("overlay.chat_platform")}
								onchange={(ev: Event) => {
									const platform = (ev.target as HTMLSelectElement)
										.value as ChatChannel["platform"];
									set(
										channels.map((row, j) =>
											j === i ? { ...row, platform } : row,
										),
									);
								}}
							>
								{CHAT_PLATFORMS.map((pf) => (
									<option key={pf} value={pf}>
										{platformLabel(pf)}
									</option>
								))}
							</select>
							<input
								value={c.channel}
								placeholder={t("overlay.chat_channel_ph")}
								aria-label={t("overlay.chat_channel")}
								oninput={(ev: Event) => {
									const channel = (ev.target as HTMLInputElement).value;
									set(
										channels.map((row, j) =>
											j === i ? { ...row, channel } : row,
										),
									);
								}}
							/>
							<button
								class="ov-channel-remove"
								type="button"
								aria-label={t("overlay.chat_remove_channel")}
								onclick={() =>
									set(channels.filter((_, j) => j !== i))
								}
							>
								<Icon name="close" class="role-icon" />
							</button>
						</div>
					))
				)}
				<button
					class="ov-channel-add"
					type="button"
					onclick={() =>
						set([...channels, { platform: CHAT_PLATFORMS[0], channel: "" }])
					}
				>
					+ {t("overlay.chat_add_channel")}
				</button>
			</div>
		</div>
	);
	},
} as MithrilJSXComponent<ElementProps>;

export interface ListFieldColumn {
	/** The sub-field key on each row object. */
	key: string;
	/** The i18n label (rendered only as an aria-label; the row is one table). */
	label: string;
	type?: "text" | "number" | "bool";
}

/** A generic list-of-objects editor. `rows` is the current prop array; editing
 * a cell or adding/removing a row mutates `props[key]`. */
export const ListField = {
	view: (vnode: m.Vnode): Vnode => {
		// Mithril calls a component's `view` with the vnode — props live in attrs.
	// The prop key is named `propKey` because Mithril reserves `key` (it
	// becomes the diff key, never an attr); `label` is the i18n label for the
	// whole list and `addRow` the factory for a fresh empty row.
	const { element, mutate, propKey, label, columns, addRow, addLabel } =
		vnode.attrs as {
			element: OverlayElement;
			mutate: (fn: (el: OverlayElement) => void) => void;
			propKey: string;
			label: string;
			columns: ListFieldColumn[];
			addRow: () => Record<string, unknown>;
			addLabel: string;
		};
	const rows = (element.props[propKey] ?? []) as Array<Record<string, unknown>>;
	const set = (next: Array<Record<string, unknown>>): void =>
		mutate((el) => {
			el.props[propKey] = next;
		});
	const setCell = (i: number, colKey: string, value: unknown): void =>
		set(rows.map((r, j) => (j === i ? { ...r, [colKey]: value } : r)));

	const cell = (row: Record<string, unknown>, i: number, c: ListFieldColumn) => {
		if (c.type === "number")
			return (
				<input
					class="ov-list-num"
					type="number"
					value={Number(row[c.key] ?? 0)}
					aria-label={c.label}
					oninput={(ev: Event) =>
						setCell(i, c.key, Number((ev.target as HTMLInputElement).value))
					}
				/>
			);
		if (c.type === "bool")
			return (
				<input
					class="ov-list-bool"
					type="checkbox"
					checked={row[c.key] === true}
					aria-label={c.label}
					onchange={(ev: Event) =>
						setCell(i, c.key, (ev.target as HTMLInputElement).checked)
					}
				/>
			);
		return (
			<input
				value={String(row[c.key] ?? "")}
				aria-label={c.label}
				oninput={(ev: Event) =>
					setCell(i, c.key, (ev.target as HTMLInputElement).value)
				}
			/>
		);
	};

	return (
		<div class="ov-field">
			<span class="ov-lbl">{label}</span>
			<div class="ov-channels">
				{rows.length === 0 ? (
					<div class="ov-channels-empty">{t("overlay.no_rows")}</div>
				) : (
					rows.map((row, i) => (
						<div class="ov-list-row" key={i}>
							{columns.map((c) => (
								m("span", { key: c.key, class: "ov-list-cell" }, [
									cell(row, i, c),
								])
							))}
							<button
								class="ov-channel-remove"
								type="button"
								aria-label={t("overlay.remove_row")}
								onclick={() => set(rows.filter((_, j) => j !== i))}
							>
								<Icon name="close" class="role-icon" />
							</button>
						</div>
					))
				)}
				<button
					class="ov-channel-add"
					type="button"
					onclick={() => set([...rows, addRow()])}
				>
					+ {addLabel}
				</button>
			</div>
		</div>
	);
	},
} as MithrilJSXComponent<{
	element: OverlayElement;
	mutate: (fn: (el: OverlayElement) => void) => void;
	propKey: string;
	label: string;
	columns: ListFieldColumn[];
	addRow: () => Record<string, unknown>;
	addLabel: string;
}>;
