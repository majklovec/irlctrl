/** @jsx m */
/*
 * Interactive Leaflet map (TODO/09-map.md). Tile providers: OpenStreetMap
 * (default), ArcGIS satellite, and Mapy.com tourist (only when an API key
 * is set).
 *
 * Both markers are plain divs (UTF-8 glyphs, never Leaflet image markers):
 * the configured centre — colour/size/glyph props — and the start position
 * (e.g. the route start), its own glyph/colour/size props.
 *
 * An optional info box below the map renders a `{token}` template. Computed
 * tokens: `{distance}` (geodesic start→centre, follows the camera while
 * panning), `{time}` (since the centre last moved) and `{status}` (idle/
 * live/stale from the last move against `liveThreshold` seconds, with the
 * texts taken from the comma-separated `status` prop when provided). Any
 * other token resolves to a project variable
 * of that name, so the same box can show battery, coordinates, … The
 * runtime `path.start/{name}` / `path.end/{name}` events stamp the centre
 * position time (the phone pipeline posts them after pushing a GPS fix);
 * the history/persistence half of 09-map.md lands with the backend.
 *
 * Leaflet (JS + CSS) is lazy-loaded from a CDN on first render — it is NOT
 * assumed globally available. The `L` global is created by the script; the
 * `declare` below only satisfies the type checker.
 */

declare const L: any;

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { bindableForm, bindField, type FormRow } from "@ui/overlay/fields";
import { parseTemplate } from "@ui/overlay/template_tokens";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { cleanBool, cleanHex, cleanNum, cleanStr } from "./schema_utils";

/* ── Props ────────────────────────────────────────────────────────── */

export type LiveMapProvider = "osm" | "arcgis" | "mapy";

/** Marker glyphs offered in the icon selects (both markers share the set). */
export const LIVE_MAP_ICONS: readonly string[] = [
	"●",
	"▲",
	"■",
	"◆",
	"★",
	"⚑",
	"✚",
	"♥",
	"☀",
	"⚡",
	"📍",
	"🏁",
	"🏠",
	"🚗",
];

/** The icon-select options (labels are the glyphs themselves). */
const ICON_OPTIONS: { value: string; label: string }[] = LIVE_MAP_ICONS.map(
	(g) => ({ value: g, label: g }),
);

export interface LiveMapProps {
	provider: LiveMapProvider;
	zoom: number;
	centerLat: number;
	centerLon: number;
	mapyKey: string;
	/** UTF-8 glyph of the centre marker (one of `LIVE_MAP_ICONS`). */
	centerIcon: string;
	/** Colour of the centre marker. */
	centerColor: string;
	/** Centre marker glyph size, in pixels. */
	centerSize: number;
	/** Marker position, e.g. the route start point. */
	startPosition: { lat: number; lon: number };
	/** UTF-8 glyph of the start marker (one of `LIVE_MAP_ICONS`). */
	startIcon: string;
	/** Colour of the start marker. */
	startColor: string;
	/** Start marker glyph size, in pixels. */
	startSize: number;
	/** Draw the templated info box below the map. */
	showInfo: boolean;
	/** Info-box `{token}` template. */
	infoTemplate: string;
	/** Info-box font size, in pixels. */
	infoFontSize: number;
	/** Info-box padding, in pixels. */
	infoPadding: number;
	/** Info-box text colour. */
	infoColor: string;
	/** Info-box background colour. */
	infoBackground: string;
	/** `{status}` texts as `idle,live,stale` (comma-separated, in that
	 * order); missing parts fall back to the built-in translations.
	 * Empty = idle/live/stale are the built-in translations. */
	status: string;
	/** Seconds the computed status stays "live" after the centre last moved. */
	liveThreshold: number;
}

export const DEFAULT_LIVE_MAP_PROPS: Required<LiveMapProps> = {
	provider: "osm",
	zoom: 15,
	centerLat: 50.1635,
	centerLon: 12.4034,
	mapyKey: "",
	centerIcon: "●",
	centerColor: "#3a7afe",
	centerSize: 26,
	startPosition: { lat: 50.1635, lon: 12.4034 },
	startIcon: "▶",
	startColor: "#d6007f",
	startSize: 22,
	showInfo: false,
	infoTemplate: "{distance} · {status}",
	infoFontSize: 14,
	infoPadding: 8,
	infoColor: "#ffffff",
	infoBackground: "#000000",
	status: "",
	liveThreshold: 20,
};

function providerUrl(key: LiveMapProvider): string {
	switch (key) {
		case "arcgis":
			return "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
		case "mapy":
			return "https://api.mapy.com/v1/maptiles/outdoor/256/{z}/{x}/{y}?apikey={key}";
		default:
			return "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
	}
}

function providerAttribution(key: LiveMapProvider): string {
	switch (key) {
		case "arcgis":
			return '&copy; Powered by <a href="https://www.esri.com/">Esri</a>';
		case "mapy":
			return '&copy; <a href="https://api.mapy.com/copyright">Seznam.cz</a>';
		default:
			return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
	}
}

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
    /* Glyph markers are plain divs so tile effects and Leaflet's image
     * machinery never reach them; the glyph sits dead-centre. */
    .live-map-glyph {
      display: flex; align-items: center; justify-content: center;
      line-height: 1; text-align: center;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .55);
    }
    /* The info box is a full-width row BELOW the map, right-aligned.
     * Font size, padding, and colours are per-element props (inline). */
    .live-map-info {
      box-sizing: border-box; width: 100%; text-align: right;
      border-radius: 4px; white-space: nowrap;
    }
  `;
	document.head.appendChild(s);
}

/* ── Geodesic distance + time formatting ───────────────────────────── */

function distanceMeters(
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
): number {
	const toRad = Math.PI / 180;
	const R = 6371000;
	const φ1 = aLat * toRad;
	const φ2 = bLat * toRad;
	const dφ = (bLat - aLat) * toRad;
	const dλ = (bLon - aLon) * toRad;
	const h =
		Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(metres: number): string {
	return metres < 1000
		? `${Math.round(metres).toLocaleString("en")} m`
		: `${(metres / 1000).toLocaleString("en", { maximumFractionDigits: 1 })} km`;
}

/** Whole seconds → `m:ss` (or `h:mm:ss` past an hour): the `{time}` token. */
function formatClock(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
		: `${m}:${String(s % 60).padStart(2, "0")}`;
}

/* ── Map initialisation ───────────────────────────────────────────── */

interface MapState {
	map: any;
	container: HTMLElement;
	// The element id this map instance belongs to — onTrigger has no DOM
	// handle, so it finds its state through this.
	elementId: string;
	resizeObserver: ResizeObserver;
	// One tile layer per available provider; `layers[provider]` is the
	// visible one, so switching only toggles visibility.
	layers: Partial<Record<LiveMapProvider, any>>;
	// `""` until the first sync has picked a provider.
	provider: LiveMapProvider | "";
	// `null` until the first sync has built the layer set.
	mapyKey: string | null;
	centerMarker: any;
	startMarker: any;
	centerLat: number;
	centerLon: number;
	zoom: number;
	// When the centre last moved (a pan, a prop change, or a runtime
	// path.start / path.end event); `null` = it never moved. Feeds `{time}`
	// and `{status}`.
	lastAt: number | null;
	// Latest render context; the info box resolves `{token}`s against it.
	ctx: ElementContext;
	// Info-box node rendered below the map; `null` while the box is hidden.
	info: HTMLElement | null;
	// 1 s tick refreshing `{time}`/`{status}`; 0 while not started.
	interval: 0 | ReturnType<typeof setInterval>;
	// Latest resolved props; the info box reads from it live.
	lastProps: LiveMapProps;
}

/** Per-container state — `L.map()` initialises a node exactly once, so
 * Mithril redraws (prop changes) re-use the live map and patch it via
 * `syncMap` instead of rebuilding; `onremove` disposes it. `starting`
 * tracks containers whose async Leaflet load is in flight. */
const maps = new Map<HTMLElement, MapState>();
const starting = new Set<HTMLElement>();

function makeTileLayer(key: LiveMapProvider, mapyKey: string): any {
	return L.tileLayer(
		providerUrl(key).replace("{key}", encodeURIComponent(mapyKey)),
		{
			maxNativeZoom: 19,
			maxZoom: 25,
			minZoom: 0,
			attribution: providerAttribution(key),
			opacity: 1,
		},
	);
}

const PROVIDER_ORDER: LiveMapProvider[] = ["osm", "arcgis", "mapy"];

/** A glyph divIcon; the box grows with the glyph so the marker stays
 * centred at any size. Markup-wise unsafe characters are dropped. */
function glyphIcon(icon: string, color: string, size: number): any {
	const safe = icon.replace(/[<>&"']/g, "");
	const box = Math.max(size + 8, 16);
	return L.divIcon({
		className: "live-map-glyph",
		html: `<span style="color:${color};font-size:${size}px">${safe}</span>`,
		iconSize: [box, box],
		iconAnchor: [box / 2, box / 2],
	});
}

/** Re-point a glyph marker at its position and (re)build its icon. */
function setGlyph(
	marker: any,
	latLon: [number, number],
	icon: string,
	color: string,
	size: number,
): void {
	marker.setLatLng(latLon);
	marker.setIcon(glyphIcon(icon, color, size));
}

/** Switch the visible tile layer to `p.provider` (falling back to the first
 * available one — mapy needs a key). */
function setProvider(state: MapState, p: LiveMapProps): void {
	const { map } = state;
	const want =
		PROVIDER_ORDER.find((k) => k === p.provider && state.layers[k]) ??
		PROVIDER_ORDER.find((k) => state.layers[k]);
	if (!want) return;
	if (state.provider !== want) {
		const old = state.layers[state.provider as LiveMapProvider];
		if (old) map.removeLayer(old);
		map.addLayer(state.layers[want]);
		state.provider = want;
	}
}

/** The `{status}` token: idle/live/stale from how long ago the centre last
 * moved, using the texts from the comma-separated `status` prop
 * (`idle,live,stale`); missing parts fall back to the built-in
 * translations. */
function statusText(state: MapState, p: LiveMapProps): string {
	const parts = p.status.split(",").map((s) => s.trim());
	if (state.lastAt === null)
		return parts[0] || t("overlay.live_map_status_idle");
	const age = (Date.now() - state.lastAt) / 1000;
	if (age <= p.liveThreshold)
		return parts[1] || t("overlay.live_map_status_live");
	return parts[2] || t("overlay.live_map_status_stale");
}

/** Re-render the info box from the live map state. Reads
 * `state.lastProps`/`state.ctx` so it stays current between redraws. */
function refreshInfo(state: MapState): void {
	const box = state.info;
	if (!box) return;
	const p = state.lastProps;
	const c = state.map.getCenter();
	const computed: Record<string, string> = {
		distance: formatDistance(
			distanceMeters(p.startPosition.lat, p.startPosition.lon, c.lat, c.lng),
		),
		time:
			state.lastAt === null
				? "–"
				: formatClock((Date.now() - state.lastAt) / 1000),
		status: statusText(state, p),
	};
	// A project variable of a token's name wins over the computed tokens —
	// the same precedence the other templated elements use.
	box.textContent = parseTemplate(p.infoTemplate)
		.map((seg) => {
			if (!seg.token) return seg.text;
			const variable = state.ctx.variableNames.get(seg.text);
			if (variable !== undefined) return String(variable);
			return computed[seg.text] ?? "";
		})
		.join("");
}

/** The centre follows panning: move the marker, stamp the position time,
 * and refresh the info box. */
function trackCenter(state: MapState): void {
	const c = state.map.getCenter();
	if (
		Math.abs(c.lat - state.centerLat) <= 1e-9 &&
		Math.abs(c.lng - state.centerLon) <= 1e-9
	)
		return;
	state.centerLat = c.lat;
	state.centerLon = c.lng;
	state.centerMarker.setLatLng([c.lat, c.lng]);
	state.lastAt = Date.now();
	refreshInfo(state);
}

/** Apply a resolved props object to the live map in place — the single place
 * props changes become visible. */
function syncMap(state: MapState, p: LiveMapProps): void {
	const { map } = state;

	// Tile layer URLs embed the mapy key — (re)build the layer set when the
	// key changed (`null` on the first sync always rebuilds).
	if (state.mapyKey !== p.mapyKey) {
		for (const k of Object.keys(state.layers) as LiveMapProvider[])
			map.removeLayer(state.layers[k]);
		state.layers = {};
		for (const k of PROVIDER_ORDER) {
			if (k === "mapy" && !p.mapyKey) continue;
			state.layers[k] = makeTileLayer(k, p.mapyKey);
		}
		state.mapyKey = p.mapyKey;
		state.provider = "";
	}
	setProvider(state, p);

	if (p.centerLat !== state.centerLat || p.centerLon !== state.centerLon) {
		state.centerLat = p.centerLat;
		state.centerLon = p.centerLon;
		state.centerMarker.setLatLng([p.centerLat, p.centerLon]);
		// A prop-driven move IS a new position — stamp it (trackCenter does).
		state.lastAt = Date.now();
		map.panTo([p.centerLat, p.centerLon]);
	}
	if (p.zoom !== state.zoom) {
		state.zoom = p.zoom;
		map.setZoom(p.zoom);
	}

	setGlyph(
		state.centerMarker,
		[p.centerLat, p.centerLon],
		p.centerIcon,
		p.centerColor,
		p.centerSize,
	);
	setGlyph(
		state.startMarker,
		[p.startPosition.lat, p.startPosition.lon],
		p.startIcon,
		p.startColor,
		p.startSize,
	);

	if (
		p.showInfo !== state.lastProps.showInfo ||
		p.infoTemplate !== state.lastProps.infoTemplate ||
		p.infoFontSize !== state.lastProps.infoFontSize ||
		p.infoPadding !== state.lastProps.infoPadding ||
		p.infoColor !== state.lastProps.infoColor ||
		p.infoBackground !== state.lastProps.infoBackground ||
		p.status !== state.lastProps.status ||
		p.liveThreshold !== state.lastProps.liveThreshold
	)
		refreshInfo(state);
	state.lastProps = p;
}

function initMap(
	container: HTMLElement,
	props: LiveMapProps,
	elementId: string,
	ctx: ElementContext,
): MapState {
	const map = L.map(container, {
		zoomControl: false,
		attributionControl: false,
	}).setView([props.centerLat, props.centerLon], props.zoom);
	L.control
		.attribution({
			position: "topright",
		})
		.addTo(map);
	// Leaflet does not reflow when the container size changes (overlay
	// elements are drag-resizable) — invalidate the size to re-tile.
	const resizeObserver = new ResizeObserver(() => map.invalidateSize());
	resizeObserver.observe(container);

	// Glyph markers: the configured centre and the start position.
	const centerMarker = L.marker([props.centerLat, props.centerLon], {
		interactive: false,
		keyboard: false,
	}).addTo(map);
	const startMarker = L.marker(
		[props.startPosition.lat, props.startPosition.lon],
		{ interactive: false, keyboard: false, title: "Start position" },
	).addTo(map);

	const state: MapState = {
		map,
		container,
		elementId,
		resizeObserver,
		layers: {},
		provider: "",
		mapyKey: null,
		centerMarker,
		startMarker,
		centerLat: props.centerLat,
		centerLon: props.centerLon,
		zoom: props.zoom,
		lastAt: null,
		ctx,
		info: null,
		interval: 0,
		lastProps: props,
	};
	maps.set(container, state);

	// 1 s tick: `{time}`/`{status}` age out between map events.
	state.interval = setInterval(() => refreshInfo(state), 1000);

	map.on("movestart", () => trackCenter(state));
	map.on("zoomend", () => refreshInfo(state));

	// The info node may already be in the DOM — Mithril renders it before
	// the async Leaflet load finishes.
	state.info = (container.parentElement?.querySelector(
		":scope > .live-map-info",
	) ?? null) as HTMLElement | null;
	syncMap(state, props);
	return state;
}

/** Runtime trigger: a `path.start/…` / `path.end/…` event named for this
 * element stamps the centre position time, flipping `{status}` live. The
 * element is persistent — it renders all the time and only reacts; the
 * claim itself is declined (no trigger state). */
function onTrigger(
	element: OverlayElement,
	eventName: string,
	_payload: Record<string, unknown>,
	_ctx: ElementContext,
): number | undefined {
	if (
		!eventName.startsWith("path.start/") &&
		!eventName.startsWith("path.end/")
	)
		return undefined;
	const state = [...maps.values()].find((s) => s.elementId === element.id);
	if (state) {
		state.lastAt = Date.now();
		refreshInfo(state);
	}
	return undefined;
}

/* ── Mithril draw ─────────────────────────────────────────────────── */

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	const p = safeProps(element.props);
	// The info box is a sibling of the map div — their shared state lives on
	// the outer wrapper's first child (the map container).
	const stateFor = (node: HTMLElement): MapState | undefined =>
		maps.get(node.parentElement?.firstElementChild as HTMLElement);
	return m(
		"div",
		{
			style: {
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
			},
		},
		[
			m("div", {
				style: { flex: "1 1 auto", minHeight: "0" },
				oncreate: (vnode) => {
					const container = vnode.dom as HTMLElement;
					// A map (or an in-flight init) already exists for this node.
					if (maps.get(container) || starting.has(container)) return;
					starting.add(container);
					injectStyles();
					void ensureLeaflet().then(() => {
						starting.delete(container);
						// The node was removed while Leaflet was loading.
						if (maps.get(container)) return;
						// `element.props` is mutated in place, so this is the
						// latest state even if props changed while Leaflet was
						// loading.
						maps.set(
							container,
							initMap(container, safeProps(element.props), element.id, ctx),
						);
					});
				},
				// Prop changes re-render into the same DOM node (oncreate does
				// not re-run) — apply them to the live map in place.
				onupdate: (vnode) => {
					const state = maps.get(vnode.dom as HTMLElement);
					if (state) {
						state.ctx = ctx;
						syncMap(state, safeProps(element.props));
					}
				},
				onremove: (vnode) => {
					const container = vnode.dom as HTMLElement;
					starting.delete(container);
					const state = maps.get(container);
					if (state) {
						maps.delete(container);
						if (state.interval) clearInterval(state.interval);
						state.resizeObserver.disconnect();
						state.map.remove();
					}
				},
			}),
			// The info box sits BELOW the map — the map's move/zoom events and
			// the 1 s tick refresh its text (see `refreshInfo`).
			p.showInfo
				? m("div", {
						class: "live-map-info",
						style: {
							fontSize: `${p.infoFontSize}px`,
							padding: `${p.infoPadding}px`,
							color: p.infoColor,
							background: p.infoBackground,
						},
						oncreate: (vnode) => {
							const st = stateFor(vnode.dom as HTMLElement);
							if (st) {
								st.info = vnode.dom as HTMLElement;
								refreshInfo(st);
							}
						},
						onremove: (vnode) => {
							const st = stateFor(vnode.dom as HTMLElement);
							if (st) st.info = null;
						},
					})
				: null,
		],
	);
}

/* ── Edit form ────────────────────────────────────────────────────── */

function editForm({
	element: e,
	mutate,
	variables,
	variableUrl,
}: ElementProps): Vnode {
	const p = safeProps(e.props);
	const sp = { mutate, variables, variableUrl };
	// `startPosition` writes into a nested object, so it stays a raw Vnode
	// row (the descriptor builder performs flat `props.<key>` writes only).
	const num = (
		key: "zoom" | "centerLat" | "centerLon" | "startPosition",
		sub: "lat" | "lon" | null,
		title: string,
		min: number,
		max: number,
	): Vnode => {
		const value = sub ? p.startPosition?.[sub] : (p[key] as number | undefined);
		return bindField(
			e,
			`props.${key}${sub ? `.${sub}` : ""}`,
			title,
			<input
				type="number"
				step={key === "zoom" ? 1 : 0.0001}
				min={min}
				max={max}
				value={typeof value === "number" && Number.isFinite(value) ? value : 0}
				oninput={(ev: Event) =>
					mutate((el) => {
						const raw = Number((ev.target as HTMLInputElement).value);
						const safe = Number.isFinite(raw) ? raw : 0;
						if (sub)
							el.props.startPosition = {
								...((el.props.startPosition as object) ?? {}),
								[sub]: safe,
							};
						else el.props[key] = safe;
					})
				}
			/>,
			sp,
		);
	};
	return bindableForm({
		element: e,
		mutate,
		variables,
		variableUrl,
		rows: [
			[
				{
					path: "props.provider",
					labelKey: "overlay.live_map_provider",
					type: "select",
					value: p.provider,
					options: [
						{ value: "osm", label: t("overlay.live_map_provider.osm") },
						{ value: "arcgis", label: t("overlay.live_map_provider.arcgis") },
						{ value: "mapy", label: t("overlay.live_map_provider.mapy") },
					],
				},
				{
					path: "props.zoom",
					labelKey: "overlay.live_map_zoom",
					type: "number",
					value: p.zoom,
					min: 0,
					max: 25,
					step: 1,
				},
			],
			[
				{
					path: "props.centerLat",
					labelKey: "overlay.live_map_center_lat",
					type: "number",
					value: p.centerLat,
					min: -90,
					max: 90,
					step: 0.0001,
				},
				{
					path: "props.centerLon",
					labelKey: "overlay.live_map_center_lon",
					type: "number",
					value: p.centerLon,
					min: -180,
					max: 180,
					step: 0.0001,
				},
			],
			[
				{
					path: "props.centerIcon",
					labelKey: "overlay.live_map_center_icon",
					type: "select",
					value: p.centerIcon,
					options: ICON_OPTIONS,
				},
				{
					path: "props.centerColor",
					labelKey: "overlay.live_map_center_color",
					type: "color",
					value: p.centerColor,
				},
				{
					path: "props.centerSize",
					labelKey: "overlay.live_map_center_size",
					type: "number",
					value: p.centerSize,
					min: 8,
					max: 96,
					step: 1,
				},
			],
			<div class="ov-field">
				<span class="ov-lbl">{t("overlay.live_map_start_position")}</span>
			</div>,
			<div class="ov-grid2">
				{num("startPosition", "lat", t("overlay.live_map_start_lat"), -90, 90)}
				{num(
					"startPosition",
					"lon",
					t("overlay.live_map_start_lon"),
					-180,
					180,
				)}
			</div>,
			[
				{
					path: "props.startIcon",
					labelKey: "overlay.live_map_start_icon",
					type: "select",
					value: p.startIcon,
					options: ICON_OPTIONS,
				},
				{
					path: "props.startColor",
					labelKey: "overlay.live_map_start_color",
					type: "color",
					value: p.startColor,
				},
				{
					path: "props.startSize",
					labelKey: "overlay.live_map_start_size",
					type: "number",
					value: p.startSize,
					min: 8,
					max: 96,
					step: 1,
				},
			],
			[
				{
					path: "props.showInfo",
					labelKey: "overlay.live_map_show_info",
					type: "checkbox",
					value: p.showInfo === true,
				},
			],
			...(p.showInfo
				? ([
						[
							{
								path: "props.infoTemplate",
								labelKey: "overlay.live_map_info_template",
								type: "text",
								value: p.infoTemplate,
							},
						],
						[
							{
								path: "props.infoFontSize",
								labelKey: "overlay.live_map_info_font_size",
								type: "number",
								value: p.infoFontSize,
								min: 8,
								max: 96,
								step: 1,
							},
							{
								path: "props.infoPadding",
								labelKey: "overlay.live_map_info_padding",
								type: "number",
								value: p.infoPadding,
								min: 0,
								max: 48,
								step: 1,
							},
						],
						[
							{
								path: "props.infoColor",
								labelKey: "overlay.live_map_info_color",
								type: "color",
								value: p.infoColor,
							},
							{
								path: "props.infoBackground",
								labelKey: "overlay.live_map_info_background",
								type: "color",
								value: p.infoBackground,
							},
						],
					] as FormRow[])
				: ([] as FormRow[])),
			[
				{
					path: "props.status",
					labelKey: "overlay.live_map_status",
					type: "text",
					value: p.status,
				},
				{
					path: "props.liveThreshold",
					labelKey: "overlay.live_map_live_threshold",
					type: "number",
					value: p.liveThreshold,
					min: 0,
					max: 3600,
					step: 1,
				},
			],
			[
				{
					path: "props.mapyKey",
					labelKey: "overlay.live_map_mapy_key",
					type: "text",
					value: p.mapyKey,
				},
			],
		],
	});
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const p = safeProps(e.props);
	if (p.centerLat < -90 || p.centerLat > 90)
		problems.push("centerLat out of range (-90–90)");
	if (p.centerLon < -180 || p.centerLon > 180)
		problems.push("centerLon out of range (-180–180)");
	const sp = p.startPosition;
	if (sp.lat < -90 || sp.lat > 90 || sp.lon < -180 || sp.lon > 180)
		problems.push("startPosition out of range");
	return problems;
}

/* ── Element definition ───────────────────────────────────────────── */

/** Runtime-safe prop view: coerces a (resolved) props record to the full
 * LiveMapProps shape. Mirrors `normalizeProps` (the server normalizes on
 * save, binding values resolve at render time) so a partial or stale record
 * can't break the map. */
/** A marker glyph from `LIVE_MAP_ICONS` (free-typed or stale values fall
 * back to the default, so the select always has a matching option). */
function iconOf(value: unknown, fallback: string): string {
	const s = cleanStr(value, 8);
	return LIVE_MAP_ICONS.includes(s) ? s : fallback;
}

function safeProps(rawInput: unknown): LiveMapProps {
	const d = DEFAULT_LIVE_MAP_PROPS;
	const raw: Record<string, unknown> =
		rawInput && typeof rawInput === "object"
			? (rawInput as Record<string, unknown>)
			: {};
	const provider = raw.provider as LiveMapProvider;
	const rawStart = (raw.startPosition ?? {}) as {
		lat?: unknown;
		lon?: unknown;
	};
	return {
		provider:
			provider === "osm" || provider === "arcgis" || provider === "mapy"
				? provider
				: d.provider,
		zoom: cleanNum(raw.zoom, d.zoom, 0, 25),
		centerLat: cleanNum(raw.centerLat, d.centerLat, -90, 90),
		centerLon: cleanNum(raw.centerLon, d.centerLon, -180, 180),
		mapyKey: cleanStr(raw.mapyKey, 200),
		centerIcon: iconOf(raw.centerIcon, d.centerIcon),
		centerColor: cleanHex(raw.centerColor, d.centerColor),
		centerSize: cleanNum(raw.centerSize, d.centerSize, 8, 96),
		startPosition: {
			lat: cleanNum(rawStart.lat, d.startPosition.lat, -90, 90),
			lon: cleanNum(rawStart.lon, d.startPosition.lon, -180, 180),
		},
		startIcon: iconOf(raw.startIcon, d.startIcon),
		startColor: cleanHex(raw.startColor, d.startColor),
		startSize: cleanNum(raw.startSize, d.startSize, 8, 96),
		showInfo: cleanBool(raw.showInfo),
		infoTemplate: cleanStr(raw.infoTemplate, 400) || d.infoTemplate,
		infoFontSize: cleanNum(raw.infoFontSize, d.infoFontSize, 8, 96),
		infoPadding: cleanNum(raw.infoPadding, d.infoPadding, 0, 48),
		infoColor: cleanHex(raw.infoColor, d.infoColor),
		infoBackground: cleanHex(raw.infoBackground, d.infoBackground),
		status: cleanStr(raw.status, 100),
		liveThreshold: cleanNum(raw.liveThreshold, d.liveThreshold, 0, 3600),
	};
}

export const liveMapElement: OverlayElementDef & OverlayElementSchema = {
	type: "live_map",
	category: "widgets",

	labelKey: "overlay.add_live_map",
	icon: () => <Icon name="target" class="role-icon" />,
	order: 100,
	// Deep clone: `startPosition` is a nested object shared by reference.
	defaultProps: {
		...DEFAULT_LIVE_MAP_PROPS,
		startPosition: { ...DEFAULT_LIVE_MAP_PROPS.startPosition },
	},
	propKeys: [
		"provider",
		"zoom",
		"centerLat",
		"centerLon",
		"mapyKey",
		"centerIcon",
		"centerColor",
		"centerSize",
		"startPosition",
		"startIcon",
		"startColor",
		"startSize",
		"showInfo",
		"infoTemplate",
		"infoFontSize",
		"infoPadding",
		"infoColor",
		"infoBackground",
		"status",
		"liveThreshold",
	],
	defaultSize: { width: 640, height: 420 },
	draw,
	editForm,
	validate,
	handles: "box",
	/** Always on screen at runtime; it only reacts to its path events. */
	persistent: true,
	onTrigger,
	normalizeProps(props, read) {
		const d = DEFAULT_LIVE_MAP_PROPS;
		const rawStart = props.startPosition as
			| { lat?: unknown; lon?: unknown }
			| undefined;
		return {
			provider: read.oneOf("provider", ["osm", "arcgis", "mapy"], d.provider),
			zoom: read.num("zoom", d.zoom, 0, 25),
			centerLat: read.num("centerLat", d.centerLat, -90, 90),
			centerLon: read.num("centerLon", d.centerLon, -180, 180),
			mapyKey: read.str("mapyKey", d.mapyKey, 200),
			centerIcon: iconOf(
				read.str("centerIcon", d.centerIcon, 10),
				d.centerIcon,
			),
			centerColor: read.hex("centerColor", d.centerColor),
			centerSize: read.num("centerSize", d.centerSize, 8, 96),
			// No object reader in PropReaders — complete a partial object from the defaults.
			startPosition: {
				lat: cleanNum(rawStart?.lat, d.startPosition.lat, -90, 90),
				lon: cleanNum(rawStart?.lon, d.startPosition.lon, -180, 180),
			},
			startIcon: iconOf(read.str("startIcon", d.startIcon, 10), d.startIcon),
			startColor: read.hex("startColor", d.startColor),
			startSize: read.num("startSize", d.startSize, 8, 96),
			showInfo: read.bool("showInfo"),
			infoTemplate: read.str("infoTemplate", d.infoTemplate, 400),
			infoFontSize: read.num("infoFontSize", d.infoFontSize, 8, 96),
			infoPadding: read.num("infoPadding", d.infoPadding, 0, 48),
			infoColor: read.hex("infoColor", d.infoColor),
			infoBackground: read.hex("infoBackground", d.infoBackground),
			status: read.str("status", d.status, 100),
			liveThreshold: read.num("liveThreshold", d.liveThreshold, 0, 3600),
		};
	},
};
