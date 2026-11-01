import { Button } from "@ui/components/";
import { Icon, type IconName } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { bindField, lbl } from "@ui/overlay/fields";
import { elementDef } from "@ui/overlay/registry";
import m from "mithril";
import type { OverlayElement, Transform } from "../../../../../shared/overlay";
import {
	deleteElement,
	mutateElementOf,
	reorderElement,
	scene,
	setElementLocked,
	state,
	toggleElementRow,
	uploadAsset,
} from "../overlay_store";

/**
 * Row-header controls for one element: the visibility and lock toggles
 * (eye / lock icons) in front of the forward / backward z-order arrows.
 */
export function zorderButtons(elementId: string): m.Vnode {
	const el = scene()?.elements.find((x) => x.id === elementId);
	const list = scene()?.elements ?? [];
	const idx = list.findIndex((x) => x.id === elementId);
	const atFront = idx === list.length - 1;
	const atBack = idx === 0;
	const ops: { op: "forward" | "backward"; dis: boolean; label: string }[] = [
		{ op: "forward", dis: atFront, label: t("overlay.bring_forward") },
		{ op: "backward", dis: atBack, label: t("overlay.send_backward") },
	];
	const toggles: {
		name: IconName;
		on: boolean;
		stateCls: string;
		label: string;
		run: () => void;
	}[] = el
		? [
				{
					name: el.visible ? "view" : "view-off",
					on: el.visible,
					stateCls: el.visible ? "" : " ov-zbtn-hidden",
					label: t("overlay.visible"),
					run: () =>
						mutateElementOf(elementId, (e) => (e.visible = !e.visible)),
				},
				{
					name: "lock",
					on: el.locked,
					stateCls: el.locked ? " ov-zbtn-locked" : "",
					label: t("overlay.locked"),
					run: () => setElementLocked(elementId, !el.locked),
				},
			]
		: [];
	return (
		<span class="ov-zhead" onclick={(e: MouseEvent) => e.stopPropagation()}>
			{toggles.map(({ name, on, stateCls, label, run }) => (
				<button
					key={name}
					type="button"
					class={"ov-zbtn" + stateCls}
					title={label}
					aria-label={label}
					aria-pressed={on}
					onclick={(ev: MouseEvent) => {
						ev.stopPropagation();
						run();
					}}
				>
					<Icon name={name} class="role-icon" width="13" height="13" />
				</button>
			))}
			{ops.map(({ op, dis, label }) => (
				<button
					key={op}
					type="button"
					class="ov-zbtn"
					title={label}
					aria-label={label}
					disabled={dis}
					onclick={(ev: MouseEvent) => {
						ev.stopPropagation();
						reorderElement(elementId, op);
					}}
				>
					{zArrow(op)}
				</button>
			))}
		</span>
	);
}

/** Small up/down chevron glyph for a z-order button. */
export function zArrow(op: "forward" | "backward"): m.Vnode {
	const up = op === "forward";
	return (
		<svg
			viewBox="0 0 24 24"
			width="15"
			height="15"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d={up ? "m6 15 6 -6 6 6" : "m6 9 6 6 6 -6"} />
		</svg>
	);
}

/**
 * List of every element in the scene, topmost (front) first. Each element is
 * an individually collapsible row: its header carries the name plus the
 * visibility/lock toggles and the z-order buttons, and expanding reveals the
 * element's property fields. Clicking a row also selects the element on the
 * canvas.
 */
export function layersPanel(): m.Vnode {
	const els = scene()?.elements ?? [];
	const frontFirst = [...els].reverse();
	return (
		<div class="ov-layers">
			<ul class="ov-layers-list">
				{frontFirst.map((el) => {
					const open = state.expandedElementId === el.id;
					return (
						<li key={el.id}>
							<div
								class={
									"ov-layer ov-el" +
									(el.id === state.selectedElementId ? " ov-layer-sel" : "")
								}
								onclick={() => toggleElementRow(el.id)}
							>
								<button
									type="button"
									class="ov-el-chevbtn"
									aria-expanded={open}
									aria-label={open ? "Collapse" : "Expand"}
									onclick={(ev: MouseEvent) => {
										ev.stopPropagation();
										state.expandedElementId = open ? null : el.id;
										m.redraw();
									}}
								>
									<Icon
										name="chevron"
										class={open ? "ov-chev ov-chev-open" : "ov-chev"}
										width="14"
										height="14"
									/>
								</button>
								<span class="ov-layer-name">{el.name}</span>
								{zorderButtons(el.id)}
							</div>
							{open ? <div class="ov-el-body">{elementProps(el)}</div> : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export function inspector(): m.Vnode {
	return <div class="ov-inspect">{layersPanel()}</div>;
}

/** Property fields for one element, rendered inside its expanded list row. */
export function elementProps(e: OverlayElement): m.Vnode {
	const tm = e.transform;
	// Mutate the row's element's real transform in place. (An earlier version
	// ran fn on a `{ ...el.transform }` copy that was discarded, so X/Y/W/H/
	// rotation/opacity edits silently did nothing.)
	const setT = (fn: (t: Transform) => void) =>
		mutateElementOf(e.id, (el) => fn(el.transform));
	// The type-specific fields are published by the element's own `editForm`
	// (OverlayElementDef) — the core renders only the common fields above and
	// delegates everything else to the registry.
	const def = elementDef(e.type);

	return (
		<>
			<label class="ov-field">
				{lbl(t("overlay.name"))}
				<input
					type="text"
					value={e.name}
					oninput={(ev: Event) =>
						mutateElementOf(e.id, (el) => {
							el.name = (ev.target as HTMLInputElement).value;
						})
					}
				/>
			</label>

			<div class="ov-grid4">
				{[
					[
						"transform.x",
						t("overlay.x"),
						tm.x,
						(n: number) => setT((x) => (x.x = Math.round(n))),
					],
					[
						"transform.y",
						t("overlay.y"),
						tm.y,
						(n: number) => setT((x) => (x.y = Math.round(n))),
					],
					[
						"transform.width",
						t("overlay.w"),
						tm.width,
						(n: number) => setT((x) => (x.width = Math.max(1, Math.round(n)))),
					],
					[
						"transform.height",
						t("overlay.h"),
						tm.height,
						(n: number) => setT((x) => (x.height = Math.max(1, Math.round(n)))),
					],
					[
						"transform.rotation",
						t("overlay.rotation"),
						tm.rotation,
						(n: number) => setT((x) => (x.rotation = n)),
					],
				].map(([path, label, value, on]) => (
					<div class="ov-gridcell" key={String(path)}>
						{bindField(
							e,
							String(path),
							String(label),
							<input
								type="number"
								value={Math.round(Number(value))}
								oninput={(ev: Event) => {
									const n = Number((ev.target as HTMLInputElement).value);
									if (Number.isFinite(n)) (on as (n: number) => void)(n);
								}}
							/>,
							{
								mutate: (fn) => mutateElementOf(e.id, fn),
								variables: state.project.variables,
							},
						)}
					</div>
				))}
			</div>

			<div class="ov-grid2">
				<div class="ov-gridcell">
					{bindField(
						e,
						"transform.opacity",
						t("overlay.opacity"),
						<input
							type="range"
							min="0"
							max="1"
							step="0.01"
							value={tm.opacity}
							oninput={(ev: Event) =>
								setT((x) => {
									x.opacity = Number((ev.target as HTMLInputElement).value);
								})
							}
						/>,
						{
							mutate: (fn) => mutateElementOf(e.id, fn),
							variables: state.project.variables,
						},
					)}
				</div>
			</div>
			{def
				? def.editForm({
						element: e,
						mutate: (fn) => mutateElementOf(e.id, fn),
						assets: state.project.assets,
						variables: state.project.variables,
						upload: (f: File) => uploadAsset(f).then((a) => a?.id ?? null),
					})
				: null}

			<div class="ov-danger">
				<Button
					label={t("overlay.delete")}
					class="ov-danger-btn"
					onclick={() => deleteElement(e.id)}
				/>
			</div>
		</>
	);
}
