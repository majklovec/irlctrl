# Handoff: Implement `live_map` overlay element

## Context

**Repository:** https://github.com/majklovec/irlctrl  
**Target directory:** `server/pages/overlays/modules/overlay_elements/elements/`  
**Registration file:** `server/pages/overlays/modules/overlay_elements/overlay_elements.tsx`

The irlctrl overlay system uses **Mithril** for rendering. Each overlay element is a TypeScript module exporting an `OverlayElementDef & OverlayElementSchema` object with `draw`, `editForm`, and `normalizeProps`. Elements are rendered inside resizable boxes and must clean up any DOM resources in `onremove`.

The UI library in use:
- `@ui/components/icons` → `Icon`
- `@ui/overlay/element` → `OverlayElement`, `OverlayElementDef`, `ElementContext`, `ElementProps`, `bindField`
- `../../../../../core/overlay_element` → `OverlayElementSchema`

## Task

Add a new overlay element called **`live_map`** that renders an interactive Leaflet map. It must:
1. Support multiple map providers: **OpenStreetMap** (default), **ArcGIS satellite**, and **Mapy.com tourist** (only if an API key is set).
2. Provide a small custom control in the top-right corner with:
   - Provider buttons (one per available provider).
   - A **`B&W`** toggle that applies `filter: grayscale(100%) invert(1)` to the tile pane only (markers must remain unaffected).
3. Be configurable from the edit form: default provider, default B&W state, zoom, center lat/lon, optional Mapy.com API key.
4. Lazily load Leaflet (JS + CSS) on first render. Do **not** assume Leaflet is globally available.
5. Clean up the map instance in `onremove`.

**Out of scope:** Supabase, live GPS tracking, realtime subscription, trail rendering, distance/time panel, demo mode. All UI text must be in **English**.

## Step 1 — Create the element file

Create `server/pages/overlays/modules/overlay_elements/elements/live_map.tsx` with the following content:

```tsx
/** @jsx m */
import { Icon } from "@ui/components/icons";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { bindField } from "@ui/overlay/element";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/* ── Lazy-load Leaflet ─────────────────────────────────────────────── */

function loadCSS(href: string): void {
	if (document.querySelector(`link[href="${href}"]`)) return;
	const l = document.createElement("link");
	l.rel = "stylesheet";
	l.href = href;
	document.head.appendChild(l);
}

function loadScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (document.querySelector(`script[src="${src}"]`)) return resolve();
		const s = document.createElement("script");
		s.src = src;
		s.onload = () => resolve();
		s.onerror = reject;
		document.head.appendChild(s);
	});
}

async function ensureLeaflet(): Promise<void> {
	if (typeof (window as any).L !== "undefined") return;
	loadCSS("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css");
	await loadScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
}

function injectStyles(): void {
	if (document.getElementById("live-map-styles")) return;
	const s = document.createElement("style");
	s.id = "live-map-styles";
	s.textContent = `
    .live-map-ctrl {
      display: flex; flex-direction: column; gap: 4px; padding: 5px;
      background: #fff; border-radius: 4px; box-shadow: 0 1px 5px rgba(0,0,0,.3);
    }
    .live-map-ctrl button {
      font: inherit; font-size: 13px; padding: 4px 8px;
      border: 1px solid #ccc; border-radius: 3px;
      background: #fff; color: #16211C; cursor: pointer; white-space: nowrap;
    }
    .live-map-ctrl button[aria-pressed="true"] {
      background: #D6007F; color: #fff; border-color: #D6007F;
    }
    .bw.leaflet-container .leaflet-tile-pane {
      filter: grayscale(100%) invert(1);
    }
    .bw.leaflet-container { background: #0e100f; }
  `;
	document.head.appendChild(s);
}

/* ── Props ────────────────────────────────────────────────────────── */

export interface LiveMapProps {
	provider: "osm" | "arcgis" | "mapy";
	blackGrayscale: boolean;
	zoom: number;
	centerLat: number;
	centerLon: number;
	mapyKey: string;
}

const DEFAULT_PROPS: LiveMapProps = {
	provider: "osm",
	blackGrayscale: false,
	zoom: 15,
	centerLat: 50.1635,
	centerLon: 12.4034,
	mapyKey: "",
};

const PROVIDERS: Record<
	string,
	{ name: string; url: string; attribution: string }
> = {
	osm: {
		name: "Map",
		url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
		attribution:
			'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
	},
	arcgis: {
		name: "Satellite",
		url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
		attribution: "&copy; Esri, Maxar, Earthstar Geographics",
	},
	mapy: {
		name: "Tourist",
		url: "https://api.mapy.com/v1/maptiles/outdoor/256/{z}/{x}/{y}?apikey={key}",
		attribution:
			'&copy; <a href="https://api.mapy.com/copyright">Seznam.cz</a>',
	},
};

/* ── Map initialisation ───────────────────────────────────────────── */

function initMap(container: HTMLElement, props: LiveMapProps): void {
	const map = L.map(container, { zoomControl: false }).setView(
		[props.centerLat, props.centerLon],
		props.zoom,
	);
	L.control.zoom({ position: "topleft" }).addTo(map);

	const layers: Record<string, any> = {};
	for (const [key, def] of Object.entries(PROVIDERS)) {
		if (key === "mapy" && !props.mapyKey) continue;
		layers[def.name] = L.tileLayer(
			def.url.replace("{key}", encodeURIComponent(props.mapyKey)),
			{
				maxZoom: 19,
				attribution: def.attribution,
			},
		);
	}

	const initialName = PROVIDERS[props.provider]?.name ?? Object.keys(layers)[0];
	layers[initialName].addTo(map);
	L.control.layers(layers, null, { position: "topright" }).addTo(map);

	const applyBW = (on: boolean) => container.classList.toggle("bw", on);
	applyBW(props.blackGrayscale);

	const ctrl = L.control({ position: "topright" });
	ctrl.onAdd = () => {
		const div = L.DomUtil.create("div", "live-map-ctrl");
		div.innerHTML =
			Object.keys(layers)
				.map(
					(name) =>
						`<button type="button" data-provider="${name}" aria-pressed="${
							name === initialName
						}">${name}</button>`,
				)
				.join("") +
			`<button type="button" data-bw aria-pressed="${props.blackGrayscale}">B&amp;W</button>`;

		div.addEventListener("click", (ev) => {
			const target = ev.target as HTMLElement;
			if (target.dataset.provider) {
				document
					.querySelectorAll(".leaflet-control-layers-base label")
					.forEach((label) => {
						if (label.textContent?.trim() === target.dataset.provider) {
							const input = label.querySelector("input");
							if (input && !input.checked) {
								input.checked = true;
								input.dispatchEvent(new Event("change", { bubbles: true }));
							}
						}
					});
				div
					.querySelectorAll("[data-provider]")
					.forEach((b: any) =>
						b.setAttribute(
							"aria-pressed",
							String(b.dataset.provider === target.dataset.provider),
						),
					);
			} else if (target.dataset.bw !== undefined) {
				const next = target.getAttribute("aria-pressed") !== "true";
				target.setAttribute("aria-pressed", String(next));
				applyBW(next);
			}
		});

		L.DomEvent.disableClickPropagation(div);
		return div;
	};
	ctrl.addTo(map);

	(container as any)._leafletMap = map;
}

/* ── Mithril draw ─────────────────────────────────────────────────── */

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const p = element.props as LiveMapProps;
	return m("div", {
		style: { width: "100%", height: "100%" },
		oncreate: async (vnode) => {
			injectStyles();
			await ensureLeaflet();
			initMap(vnode.dom as HTMLElement, p);
		},
		onremove: (vnode) => {
			const map = (vnode.dom as any)._leafletMap;
			if (map) map.remove();
		},
	});
}

/* ── Edit form ────────────────────────────────────────────────────── */

function editForm({ element: e, mutate }: ElementProps): Vnode {
	const p = e.props as LiveMapProps;
	const num = (
		key: keyof LiveMapProps,
		label: string,
		min: number,
		max: number,
	) =>
		bindField(
			e,
			`props.${key}`,
			label,
			m("input", {
				type: "number",
				min,
				max,
				value: p[key] as number,
				oninput: (ev: Event) =>
					mutate((el) => {
						(el.props as any)[key] = Number(
							(ev.target as HTMLInputElement).value,
						);
					}),
			}),
		);

	return m(
		"div",
		{ style: { display: "flex", flexDirection: "column", gap: "8px" } },
		[
			bindField(
				e,
				"props.provider",
				"Map provider",
				m(
					"select",
					{
						value: p.provider,
						onchange: (ev: Event) =>
							mutate((el) => {
								(el.props as any).provider = (
									ev.target as HTMLSelectElement
								).value;
							}),
					},
					[
						m("option", { value: "osm" }, "OpenStreetMap"),
						m("option", { value: "arcgis" }, "Satellite (ArcGIS)"),
						m("option", { value: "mapy" }, "Tourist (Mapy.com)"),
					],
				),
			),
			bindField(
				e,
				"props.blackGrayscale",
				"Black-grayscale mode",
				m("input", {
					type: "checkbox",
					checked: p.blackGrayscale,
					onchange: (ev: Event) =>
						mutate((el) => {
							(el.props as any).blackGrayscale = (
								ev.target as HTMLInputElement
							).checked;
						}),
				}),
			),
			num("zoom", "Zoom", 1, 19),
			num("centerLat", "Center latitude", -90, 90),
			num("centerLon", "Center longitude", -180, 180),
			bindField(
				e,
				"props.mapyKey",
				"Mapy.com API key (optional)",
				m("input", {
					type: "text",
					value: p.mapyKey,
					oninput: (ev: Event) =>
						mutate((el) => {
							(el.props as any).mapyKey = (ev.target as HTMLInputElement).value;
						}),
				}),
			),
		],
	);
}

/* ── Element definition ───────────────────────────────────────────── */

export const liveMapElement: OverlayElementDef & OverlayElementSchema = {
	type: "live_map",
	category: "widgets",
	labelKey: "overlay.add_live_map",
	icon: () => m(Icon, { name: "map" }),
	order: 100,
	defaultProps: { ...DEFAULT_PROPS },
	propKeys: [
		"provider",
		"blackGrayscale",
		"zoom",
		"centerLat",
		"centerLon",
		"mapyKey",
	],
	defaultSize: { width: 640, height: 420 },
	draw,
	editForm,
	handles: "box",
	normalizeProps(_props, read) {
		const d = DEFAULT_PROPS;
		return {
			provider: read.oneOf("provider", ["osm", "arcgis", "mapy"], d.provider),
			blackGrayscale: read.bool("blackGrayscale", d.blackGrayscale),
			zoom: read.num("zoom", d.zoom, 1, 19),
			centerLat: read.num("centerLat", d.centerLat, -90, 90),
			centerLon: read.num("centerLon", d.centerLon, -180, 180),
			mapyKey: read.str("mapyKey", d.mapyKey, 200),
		};
	},
};
```

## Step 2 — Register the element

Open `server/pages/overlays/modules/overlay_elements/overlay_elements.tsx` and:
1. Add the import near the other element imports:

   ```ts
   import { liveMapElement } from "./elements/live_map";
   ```
2. Add `liveMapElement` to the array of exported/registered elements (next to `chatElement` or similar).

Do **not** rename the export — other code references `liveMapElement` by name.

## Step 3 — Add the translation key

Wherever the overlay i18n strings live (likely `server/pages/overlays/modules/overlay_elements/i18n.*` or a shared translations file), add:

```ts
"overlay.add_live_map": "Live map",
```

Then add the same key to every other locale in that file (translations can be the English string or a localized version — do not skip any locale, or the picker will show the raw key).

## Step 4 — Verify

After implementing, check the following manually in the running dev environment:
1. **Element picker:** “Live map” appears in the picker under the Widgets category with the map icon. Clicking it drops a 640×420 map onto the canvas.
2. **Map renders:** OpenStreetMap tiles load with a pink live-map-control panel in the top-right containing three buttons (`Map`, `Satellite`, `Tourist`) plus a `B&W` toggle. Attribution shows Leaflet + OSM.
3. **Provider switch:** Clicking `Satellite` swaps tiles and deselects `Map` (the pressed state and the Leaflet layers control stay in sync).
4. **B&W toggle:** Clicking `B&W` inverts tile colors only. Markers/controls/attribution text remain unaffected. Clicking again restores colors.
5. **No Mapy key:** If `mapyKey` is empty, the `Tourist` button is missing from the custom control and from the Leaflet layers panel (but the option remains in the edit form).
6. **Edit form:** Changing zoom, center, default provider, or B&W and pressing save regenerates the map with the new defaults. Changing `mapyKey` to a dummy string adds the `Tourist` button (tiles will 4xx but the button appears).
7. **Resize:** Dragging the element handle reflows the map (Leaflet's default behaviour handles this; do not add `invalidateSize` unless visual glitches appear).
8. **Deletion:** Deleting the element does not throw and no `L.Map` instances leak in the console (the `onremove` teardown calls `map.remove()`).
9. **No network on load:** Before adding the element, Leaflet's CSS/JS should not be present in the `<head>`. They appear only after the element is first rendered.
10. **Two instances:** Adding two `live_map` elements produces two independent maps, each with its own control state.

## Gotchas / notes for the implementer

- **`/** @jsx m */` is required** at the top of the file — Mithril's `m` must be in scope for the JSX pragma.
- **The type import path** `../../../../../core/overlay_element` is relative to `elements/live_map.tsx`. Verify this matches the existing element files (e.g. `chat.tsx`) — if theirs is different, match theirs.
- **`L` is not imported.** It is attached to `window` after `ensureLeaflet()` resolves. TypeScript will complain unless `declare const L: any;` is added, or you use `(window as any).L`. The provided code relies on the global; add `declare const L: any;` at the top of the file if the project's `tsconfig` has `noImplicitAny`.
- **Don't skip `L.DomEvent.disableClickPropagation(div)`.** Without it, clicking the buttons also drags the map.
- **Don't move the `.bw` filter to the whole map container** — that inverts markers and controls too. Keep the CSS rule scoped to `.leaflet-tile-pane`.
- **`onremove` must call `map.remove()`** or you get "Map container is already initialized" errors when the same DOM node is reused.
- **Mapy.com provider is only meaningful with a valid API key.** Do not block the element from rendering when the key is missing — just hide the `Tourist` option as implemented.

## Acceptance summary

- One new file (`live_map.tsx`) + two-line change in `overlay_elements.tsx` + one translation key per locale.
- No changes to other elements, no changes to the overlay runtime, no Supabase, no global state.
- Map renders, two providers plus optional Mapy, working B&W toggle, clean teardown.
