import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import m from "mithril";
import type {
	ElementVariant,
	OverlayElementDef,
} from "../../../../../shared/ui/overlay/element";
import { addElement, closeToolMenus } from "../overlay_store";
import { addableElements } from "../registry";

/** Catalog sections, in display order. Membership is NOT listed here — each
 * element declares its own `category` on its `OverlayElementDef`; a section
 * is just the display slot (id + label) those declarations point at (defs
 * order within a section by `order`). */
const CATEGORIES: readonly { id: string; labelKey: string }[] = [
	{ id: "basics", labelKey: "overlay.catalog_basics" },
	{ id: "media", labelKey: "overlay.catalog_media" },
	{ id: "backgrounds", labelKey: "overlay.catalog_backgrounds" },
	{ id: "widgets", labelKey: "overlay.catalog_widgets" },
	{ id: "templates", labelKey: "overlay.catalog_templates" },
];

const TABS: readonly { id: string; labelKey: string }[] = [
	{ id: "all", labelKey: "overlay.catalog_all" },
	...CATEGORIES.map((c) => ({ id: c.id, labelKey: c.labelKey })),
];

const descKey = (type: string): string => `overlay.catalog_desc_${type}`;

/** Panel-local UI state (tab, search, collapsed sections). It is pure
 * presentation, so it stays out of the editor's observable `state`. */
const ui = { tab: "all", query: "", collapsed: new Set<string>() };

/** A card's own search text: the element type (a stable fallback) plus its
 * displayed label. */
function baseText(def: OverlayElementDef): string {
	return `${def.type} ${t(def.labelKey ?? def.type)}`.toLowerCase();
}

/** A variant card's search text: the variant's displayed label + hint (a
 * template's file slug) + the element type it inserts. */
function variantText(def: OverlayElementDef, variant: ElementVariant): string {
	return `${def.type} ${t(variant.labelKey)} ${variant.hint ?? ""}`.toLowerCase();
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
			<span class="ov-cat-card-bd">
				<span class="ov-cat-card-t">{t(def.labelKey ?? def.type)}</span>
				<span class="ov-cat-card-d">{t(descKey(def.type))}</span>
			</span>
		</button>
	);
}

/** One variant card (e.g. a ready-made template): inserts the element with
 * the variant's props preselected over its defaults. */
function variantCard(def: OverlayElementDef, variant: ElementVariant): m.Vnode {
	const title = t(variant.labelKey);
	const insert = (): void => {
		addElement(def.type, variant.props);
		closeToolMenus();
	};
	return (
		<button
			type="button"
			class="ov-cat-card"
			role="menuitem"
			title={title}
			onclick={insert}
		>
			<span class="ov-cat-card-ic">{def.icon?.() ?? <Icon name="info" />}</span>
			<span class="ov-cat-card-bd">
				<span class="ov-cat-card-t">{title}</span>
				<span class="ov-cat-card-d">
					{variant.hint ?? t(descKey(def.type))}
				</span>
			</span>
		</button>
	);
}

/** All cards for one section after the search is applied: each def's base
 * card (when it matches) followed by that def's variant cards (when THEY
 * match). An empty query shows everything. `listVariants()` also kicks the
 * declaring module's lazy catalog load, so a variant element's cards appear
 * as soon as that resolves (the panel re-renders on it). */
function sectionCards(
	defs: readonly OverlayElementDef[],
	query: string,
): m.Vnode[] {
	const cards: m.Vnode[] = [];
	for (const def of defs) {
		const variants = def.listVariants?.() ?? [];
		if (!query || baseText(def).includes(query)) cards.push(catalogCard(def));
		for (const variant of variants) {
			if (!query || variantText(def, variant).includes(query))
				cards.push(variantCard(def, variant));
		}
	}
	return cards;
}

function catalogSection(
	cat: { id: string; labelKey: string },
	cards: m.Vnode[],
): m.Vnode {
	if (!cards.length) return <></>;
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
					class={`role-icon ov-cat-chev${closed ? " is-closed" : ""}`}
					name="chevron"
				/>
				<span>{t(cat.labelKey)}</span>
			</button>
			{closed ? null : <div class="ov-cat-grid">{cards}</div>}
		</section>
	);
}

/** The element catalog panel: tabs (all / category), a search box and the
 * matching sections of element cards. A card inserts its element and
 * closes the panel. Rendered inside the toolbar's `.ov-dd` span while the
 * catalog is open. */
export function elementCatalog(): m.Vnode {
	const query = ui.query.trim().toLowerCase();
	const inTab = (d: OverlayElementDef): boolean =>
		ui.tab === "all" || d.category === ui.tab;
	const sections = CATEGORIES.filter((cat) =>
		ui.tab === "all" ? true : cat.id === ui.tab,
	).map((cat) => ({
		cat,
		cards: sectionCards(
			addableElements().filter((d) => inTab(d) && d.category === cat.id),
			query,
		),
	}));
	return (
		<div class="ov-cat" role="menu" aria-label={t("overlay.add_element")}>
			<div class="ov-cat-bar">
				<nav class="ov-cat-tabs" role="tablist">
					{TABS.map((tab) => (
						<button
							type="button"
							role="tab"
							class={`ov-cat-tab${ui.tab === tab.id ? " is-active" : ""}`}
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
				{sections.some(({ cards }) => cards.length) ? (
					sections.map(({ cat, cards }) => catalogSection(cat, cards))
				) : (
					<p class="ov-cat-empty">{t("overlay.catalog_empty")}</p>
				)}
			</div>
		</div>
	);
}
