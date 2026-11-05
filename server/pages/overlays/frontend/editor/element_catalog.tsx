import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { addableElements } from "../registry";
import m from "mithril";
import { addElement, closeToolMenus } from "../overlay_store";
import type { OverlayElementDef } from "../../../../../shared/ui/overlay/element";

/** Catalog sections, in display order. `types` are matched against the
 * registry, so the sections track what the modules register (in `order`
 * within a section). */
const CATEGORIES: readonly {
	id: string;
	labelKey: string;
	types: readonly string[];
}[] = [
	{
		id: "basics",
		labelKey: "overlay.catalog_basics",
		types: ["text", "rectangle", "ellipse", "line", "progress"],
	},
	{
		id: "media",
		labelKey: "overlay.catalog_media",
		types: ["image", "video", "iframe"],
	},
	{
		id: "widgets",
		labelKey: "overlay.catalog_widgets",
		types: [
			"chat",
			"alert",
			"weather",
			"now_playing",
			"countdown",
			"lower_third",
			"frame",
			"socials",
			"credits",
			"bool",
			"number",
			"goal",
			"spin_wheel",
			"emote_wall",
			"emote_combo",
			"featured",
		],
	},
];

const TABS: readonly { id: string; labelKey: string }[] = [
	{ id: "all", labelKey: "overlay.catalog_all" },
	...CATEGORIES.map((c) => ({ id: c.id, labelKey: c.labelKey })),
];

const descKey = (type: string): string => `overlay.catalog_desc_${type}`;

/** Panel-local UI state (tab, search, collapsed sections). It is pure
 * presentation, so it stays out of the editor's observable `state`. */
const ui = { tab: "all", query: "", collapsed: new Set<string>() };

function matches(def: OverlayElementDef, tab: string, query: string): boolean {
	if (tab !== "all") {
		const cat = CATEGORIES.find((c) => c.id === tab);
		if (!cat?.types.includes(def.type)) return false;
	}
	if (!query) return true;
	const label = t(def.labelKey ?? def.type);
	return (
		label.toLowerCase().includes(query) || def.type.toLowerCase().includes(query)
	);
}

function catalogCard(def: OverlayElementDef): m.Vnode {
	const insert = (): void => {
		addElement(def.type);
		closeToolMenus();
	};
	return (
		<button
			type="button"
			class="ov-cat-card"
			role="menuitem"
			title={t(def.labelKey ?? def.type)}
			onclick={insert}
		>
			<span class="ov-cat-card-ic">{def.icon?.() ?? <Icon name="info" />}</span>
			<span class="ov-cat-card-t">{t(def.labelKey ?? def.type)}</span>
			<span class="ov-cat-card-d">{t(descKey(def.type))}</span>
		</button>
	);
}

function catalogSection(
	cat: { id: string; labelKey: string },
	defs: readonly OverlayElementDef[],
): m.Vnode {
	if (!defs.length) return <></>;
	const closed = ui.collapsed.has(cat.id);
	const toggle = (): void => {
		if (ui.collapsed.has(cat.id)) ui.collapsed.delete(cat.id);
		else ui.collapsed.add(cat.id);
		m.redraw();
	};
	return (
		<section class="ov-cat-section">
			<button
				type="button"
				class="ov-cat-head"
				aria-expanded={closed ? "false" : "true"}
				onclick={toggle}
			>
				<Icon
					class={"role-icon ov-cat-chev" + (closed ? " is-closed" : "")}
					name="chevron"
				/>
				<span>{t(cat.labelKey)}</span>
			</button>
			{closed ? null : <div class="ov-cat-grid">{defs.map(catalogCard)}</div>}
		</section>
	);
}

/** The element catalog panel: tabs (all / category), a search box and the
 * matching sections of element cards. A card inserts its element and
 * closes the panel. Rendered inside the toolbar's `.ov-dd` span while the
 * catalog is open. */
export function elementCatalog(): m.Vnode {
	const defs = addableElements().filter((d) =>
		matches(d, ui.tab, ui.query.trim().toLowerCase()),
	);
	const sectionDefs = (cat: (typeof CATEGORIES)[number]): OverlayElementDef[] =>
		defs.filter((d) => cat.types.includes(d.type));
	return (
		<div class="ov-cat" role="menu" aria-label={t("overlay.add_element")}>
			<div class="ov-cat-bar">
				<nav class="ov-cat-tabs" role="tablist">
					{TABS.map((tab) => (
						<button
							type="button"
							role="tab"
							class={"ov-cat-tab" + (ui.tab === tab.id ? " is-active" : "")}
							aria-selected={ui.tab === tab.id ? "true" : "false"}
							onclick={() => {
								ui.tab = tab.id;
								m.redraw();
							}}
						>
							{t(tab.labelKey)}
						</button>
					))}
				</nav>
				<input
					class="ov-cat-search"
					type="search"
					placeholder={t("overlay.catalog_search")}
					aria-label={t("overlay.catalog_search")}
					value={ui.query}
					oninput={(e: Event) => {
						ui.query = (e.target as HTMLInputElement).value;
						m.redraw();
					}}
				/>
			</div>
			<div class="ov-cat-body">
				{defs.length ? (
					(ui.tab === "all"
						? CATEGORIES.map((cat) =>
								catalogSection(cat, sectionDefs(cat)),
							)
						: catalogSection(
								CATEGORIES.find((c) => c.id === ui.tab)!,
								defs,
							)
					)
				) : (
					<p class="ov-cat-empty">{t("overlay.catalog_empty")}</p>
				)}
			</div>
		</div>
	);
}
