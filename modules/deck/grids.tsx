/* GridStack ↔ Mithril bridge for the Buttons widget's internal grid. Like the
 * dashboard's bridge (frontend/ts/dashboardgrid.tsx) GridStack owns the
 * `.grid-stack-item` DOM (position, drag/resize) and Mithril owns the inner
 * cell content, mounted into each item's `.grid-stack-item-content`. Unlike the
 * dashboard (one grid per page) several grids can be alive at once (a widget's
 * live body plus the editor canvas), so managers are keyed by their host
 * element. */
import { GridStack, type GridStackWidget } from "gridstack";
import m from "mithril";
import type { MithrilJSXComponent } from "../../frontend/ts/jsx";

/** A positioned button: its slot in the internal 12-column grid, in cells. */
export interface GridItem {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ButtonsGridProps {
	/** The layout, with every item carrying a slot. */
	items: readonly GridItem[];
	/** Enable drag/resize (the editor canvas); false = inert (live body). */
	interactive: boolean;
	/** Called with the items (positions applied) after a drag/resize. */
	onLayout?: (items: GridItem[]) => void;
	/** Called when a cell is clicked (select in the editor, press in the body). */
	onSelect?: (id: string) => void;
	/** The selected cell (editor only). */
	selectedId?: string | null;
	/** Render one cell's inner content (icon, label, device…). */
	renderCell: (id: string) => m.Children;
}

interface Manager {
	host: HTMLElement;
	/** Absent once teardown ran (the manager is unregistered). */
	grid?: GridStack;
	/** Latest props, read by the mounted cell roots on every redraw. */
	current: ButtonsGridProps;
	mounted: Map<string, HTMLElement>;
}
const managers = new Map<HTMLElement, Manager>();

function contentEl(item: Element): HTMLElement {
	return (item.querySelector(":scope > .grid-stack-item-content") ??
		item) as HTMLElement;
}

function desiredNodes(items: readonly GridItem[]): GridStackWidget[] {
	// Passing content to load() would overwrite Mithril's mounted cells.
	return items.map((it) => ({
		id: it.id,
		x: it.x,
		y: it.y,
		w: it.w,
		h: it.h,
		minW: 1,
		minH: 1,
		maxW: 6,
		maxH: 6,
	}));
}

function cellView(mgr: Manager, id: string): m.Vnode {
	const cur = mgr.current;
	return (
		<div
			class={[
				"buttons-cell",
				cur.selectedId === id ? "is-selected" : undefined,
			]
				.filter(Boolean)
				.join(" ")}
			onclick={() => cur.onSelect?.(id)}
		>
			{cur.renderCell(id)}
		</div>
	);
}

/** Create a GridStack that can NEVER be wired to an enclosing grid.
 *
 * GridStack v11's constructor probes `el.closest(".grid-stack-item")` with a
 * HARDCODED base class (a distinct `itemClass` does not prevent this). This
 * host lives inside a dashboard `.grid-stack-item` (the live body) or the
 * config editor inside one, so that probe would find the widget's outer item
 * and GridStack would couple the two grids: the outer engine adopts the widget
 * as a nested sub-grid (mangling its DOM, duplicating the head in view mode)
 * and the `grid-stack-nested` CSS clips the editor content. Hiding the
 * ancestor class for the constructor's (synchronous) duration leaves the probe
 * with nothing to match; the class is restored before the next line runs, so
 * no paint or observer ever sees the hidden state. */
function createDecoupledGrid(
	host: HTMLElement,
	opts: ConstructorParameters<typeof GridStack>[1],
): GridStack {
	const itemClass = "grid-stack-item";
	const hidden: Array<{ el: Element; had: boolean }> = [];
	let el: Element | null = host;
	while (el) {
		if (el.classList?.contains(itemClass)) hidden.push({ el, had: true });
		el = el.parentElement;
	}
	try {
		for (const { el } of hidden) el.classList.remove(itemClass);
		return new GridStack(host, opts);
	} finally {
		for (const { el, had } of hidden)
			if (had) el.classList.add(itemClass);
	}
}

/** Push gridstack positions back into the items (by id) and notify the owner. */
function commitLayout(mgr: Manager): void {
	const grid = mgr.grid;
	if (!grid) return;
	const byId = new Map(grid.engine.nodes.map((n) => [n.id as string, n]));
	const updated = mgr.current.items.map((it) => {
		const n = byId.get(it.id);
		return n
			? {
					...it,
					x: n.x ?? it.x,
					y: n.y ?? it.y,
					w: n.w ?? it.w,
					h: n.h ?? it.h,
				}
			: it;
	});
	mgr.current = { ...mgr.current, items: updated };
	mgr.current.onLayout?.(updated);
}

/** Reconcile the grid with `current.items` (reload on add/remove, mount cells). */
function reconcile(mgr: Manager): void {
	const grid = mgr.grid;
	if (!grid) return;
	const cur = mgr.current;
	// Re-load ONLY when the set of ids changes (add/remove). A pure
	// drag/resize already moved the node inside GridStack; re-running
	// `grid.load` would re-pack and drift the positions we just read back.
	const desiredId = cur.items
		.map((i) => i.id)
		.sort()
		.join("\0");
	const presentId = grid.engine.nodes
		.map((n) => n.id as string)
		.sort()
		.join("\0");
	if (
		desiredId !== presentId ||
		grid.engine.nodes.length > cur.items.length
	)
		grid.load(desiredNodes(cur.items), true);

	const present = new Set(grid.engine.nodes.map((n) => n.id as string));
	for (const n of grid.engine.nodes) {
		const id = n.id;
		const item = n.el as HTMLElement | undefined;
		if (!id || !item) continue;
		const el = mgr.mounted.get(id);
		if (el && el.parentElement === item) continue; // in place
		const root = contentEl(item);
		mgr.mounted.set(id as string, root);
		m.mount(root, { view: () => cellView(mgr, id as string) });
	}
	// Unmount cells that are no longer present.
	for (const id of [...mgr.mounted.keys()]) {
		if (!present.has(id)) {
			m.mount(mgr.mounted.get(id)!, null);
			mgr.mounted.delete(id);
		}
	}
}

function setInteractive(mgr: Manager, interactive: boolean): void {
	mgr.grid?.enableMove(interactive);
	mgr.grid?.enableResize(interactive);
}

/** In the editor, keep one empty row open below the content so a key can be
 * dragged one row down. The count is a CSS custom property, not inline
 * min-height: GridStack's layout passes strip *inline* min-height/height but
 * honor the stylesheet `min-height` (`.buttons-grid-edit`) driven by this
 * property, so the reserved row survives every re-layout. */
function setEditReserve(mgr: Manager, interactive: boolean): void {
	const host = mgr.host;
	const grid = mgr.grid;
	if (!grid) return;
	if (!interactive) {
		host.classList.remove("buttons-grid-edit");
		host.style.removeProperty("--edit-min-rows");
		return;
	}
	host.style.setProperty("--edit-min-rows", String(Math.max(grid.getRow(), 1) + 1));
	host.classList.add("buttons-grid-edit");
}

function teardown(host: HTMLElement): void {
	const mgr = managers.get(host);
	if (!mgr) return;
	for (const el of mgr.mounted.values()) m.mount(el, null);
	mgr.mounted.clear();
	mgr.grid?.destroy(true);
	mgr.grid = undefined;
	managers.delete(host);
}

export const ButtonsGrid = {
	view(vnode) {
		const props = vnode.attrs as ButtonsGridProps;
		return (
			<div
				class="grid-stack buttons-grid-stack"
				oncreate={(vd: m.VnodeDOM) => {
					const host = vd.dom as HTMLElement;
					teardown(host);
					const grid = createDecoupledGrid(host, {
						column: 12,
						cellHeight: 56,
						margin: 4,
						// Let a dragged key stay where it is dropped (persistent
						// gaps) so "move one row down" onto the reserved row sticks;
						// auto-compact would snap it back up and close the gap.
						float: true,
						disableDrag: !props.interactive,
						disableResize: !props.interactive,
						resizable: { handles: "all" },
						// Scoping class for this grid's keys (the base
						// `grid-stack-item` is always added on top of it).
						itemClass: "buttons-grid-item",
					});
					const mgr: Manager = {
						host,
						grid,
						current: props,
						mounted: new Map(),
					};
					grid.on("dragstop", () => commitLayout(mgr));
					grid.on("resizestop", () => {
						commitLayout(mgr);
						// A zero-content node can be resized to a height the
						// engine clamps away; reassert the real height.
						for (const n of grid.engine.nodes) {
							const minH = n.minH ?? 1;
							if ((n.h ?? 1) < minH) {
								n.h = minH;
								n.el?.classList.remove("grid-stack-item-ghost");
							}
						}
					});
					managers.set(host, mgr);
					setInteractive(mgr, props.interactive);
					reconcile(mgr);
					setEditReserve(mgr, props.interactive);
				}}
				onupdate={(vd: m.VnodeDOM) => {
					const mgr = managers.get(vd.dom as HTMLElement);
					if (!mgr) return;
					const changed =
						mgr.current.interactive !== props.interactive ||
						mgr.current.items !== props.items;
					const prevRows = mgr.grid?.getRow() ?? 0;
					mgr.current = props;
					if (changed) reconcile(mgr);
					setInteractive(mgr, props.interactive);
					if (
						changed &&
						(mgr.grid?.getRow() ?? 0) !== prevRows
					)
						setEditReserve(mgr, props.interactive);
				}}
				onremove={(vd: m.VnodeDOM) => teardown(vd.dom as HTMLElement)}
			/>
		);
	},
} as MithrilJSXComponent<ButtonsGridProps>;
