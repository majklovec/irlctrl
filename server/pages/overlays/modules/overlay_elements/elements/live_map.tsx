/** @jsx m */
/*
 * Interactive Leaflet map (TODO/09-map.md). Tile providers: OpenStreetMap
 * (default), ArcGIS satellite, and Mapy.com tourist (only when an API key
 * is set).
 *
 * The centre marker and any number of extra markers are plain divs (UTF-8
 * glyphs, never Leaflet image markers): the configured centre, plus zero or
 * more markers (e.g. the route start) sharing one glyph/colour/size.
 *
 * An optional info box below the map renders a `{token}` template. Computed
 * tokens: `{distance1}`…`{distanceN}` (geodesic distance, camera centre →
 * each marker in `markerPositions` order, follows the camera while
 * panning), `{distance}` (the first marker's distance, kept for older
 * templates), `{time}` (since the centre last moved) and `{status}` (idle/
 * live/stale from the last move against `liveThreshold` seconds, with the
 * texts taken from the comma-separated `status` prop when provided). Any
 * other token resolves to a project variable
 * of that name, so the same box can show battery, coordinates, …
 *
 * `keepHistory` (TODO/09-map.md) records the route server-side: the phone
 * pushes GPS fixes as the variable bound to `centerPosition` (a `"lon,lat"`
 * string); the server stores every fix into the live `default` route and a
 * `path.end/{name}` event (which also stamps the centre position time)
 * renames that route to `{name}`, archiving the segment — the next fix starts
 * a fresh `default`. On the runtime page the element then polls the
 * owner-token `map-history` endpoint and draws the live `default` route as a
 * bold `historyColor` path under the live markers.
 *
 * Leaflet (JS + CSS) is lazy-loaded from a CDN on first render — it is NOT
 * assumed globally available. The `L` global is created by the script; the
 * `declare` below only satisfies the type checker.
 */

declare const L: any;

import type { ControlOption } from "@ui/components/dynamic_form";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { bindableForm, bindField, type FormRow } from "@ui/overlay/fields";
import { type Position, parsePosition, parsePositions } from "@ui/overlay/geo";
import { parseTemplate } from "@ui/overlay/template_tokens";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { cleanBool, cleanHex, cleanNum, cleanStr } from "./schema_utils";

/* ── Props ────────────────────────────────────────────────────────── */

export type LiveMapProvider = "osm" | "arcgis" | "mapy";

/** Single-colour text glyphs — they inherit the marker's `color` prop. */
const SINGLE_COLOR_ICONS: readonly string[] = [
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
];

/** Full-colour emoji — rendered in their own colours regardless of `color`. */
const COLOR_ICONS: readonly string[] = ["📍", "🏁", "🏠", "🚗"];

/** Marker glyphs offered in the icon selects (both markers share the set).
 * The flat union of the two presentational groups; `LIVE_MAP_ICONS` is the
 * single source of truth for validation, the group split is for the selects. */
export const LIVE_MAP_ICONS: readonly string[] = [
	...SINGLE_COLOR_ICONS,
	...COLOR_ICONS,
];

/** Built-in fallback for a marker slot left without its own glyph/colour in
 * `markerIcons`/`markerColors` (there is no shared "default marker" prop). */
const DEFAULT_MARKER_ICON = "▶";
const DEFAULT_MARKER_COLOR = "#d6007f";

export interface LiveMapProps {
	provider: LiveMapProvider;
	zoom: number;
	/** Centre map position as a `"lon,lat"` string (e.g. `"12.4034,50.1635"`)
	 * — a single bindable prop a GPS variable can update. */
	centerPosition: string;
	mapyKey: string;
	/** UTF-8 glyph of the centre marker (one of `LIVE_MAP_ICONS`). */
	centerIcon: string;
	/** Colour of the centre marker. */
	centerColor: string;
	/** Centre marker glyph size, in pixels. */
	centerSize: number;
	/** Extra markers as `"lon,lat"` pairs joined with `";"` (e.g. the route
	 * start point); empty = no markers. One bindable string, so a variable
	 * can push a whole multi-marker set. */
	markerPositions: string;
	/** Per-marker UTF-8 glyphs joined with `";"`, index-aligned with
	 * `markerPositions` (a missing/empty slot falls back to the built-in
	 * default glyph). */
	markerIcons: string;
	/** Per-marker hex colours joined with `";"`, index-aligned with
	 * `markerPositions` (a missing/empty slot falls back to the built-in
	 * default colour). */
	markerColors: string;
	/** Extra-marker glyph size, in pixels. */
	markerSize: number;
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
	/** Record the route in the server database and draw the live `default`
	 * path (bound to the centre variable; a `path.end/{name}` event renames
	 * it, archiving the segment); the runtime page polls and renders it. */
	keepHistory: boolean;
	/** Colour of the recorded live `default` path on the map. */
	historyColor: string;
}

export const DEFAULT_LIVE_MAP_PROPS: Required<LiveMapProps> = {
	provider: "osm",
	zoom: 15,
	centerPosition: "12.4034,50.1635",
	mapyKey: "",
	centerIcon: "●",
	centerColor: "#3a7afe",
	centerSize: 26,
	markerPositions: "",
	markerIcons: "",
	markerColors: "",
	markerSize: 22,
	showInfo: false,
	infoTemplate: "{distance} · {status}",
	infoFontSize: 14,
	infoPadding: 8,
	infoColor: "#ffffff",
	infoBackground: "#000000",
	status: "🟢,🟠,🟤",
	liveThreshold: 20,
	keepHistory: false,
	historyColor: "#d6007f",
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
	// The `markerPositions` entries, in prop order; rebuilt only when the
	// string changed (the glyph refresh below restyles them every sync).
	markers: any[];
	markerPos: Position[];
	markerPositions: string;
	// Keep-history routes (open + closed) as polylines, under the markers.
	historyLayer: any;
	// 5 s `map-history` poll while `keepHistory` is on; 0 while off.
	historyTimer: 0 | ReturnType<typeof setInterval>;
	// Last `centerPosition` strings applied (change detection; an unparseable
	// string leaves the view where it is).
	centerPos: string;
	// The camera centre; `trackCenter` updates it while panning.
	centerLat: number;
	centerLon: number;
	zoom: number;
	// When the centre last moved (a pan, a prop change, or a runtime
	// path.end event); `null` = it never moved. Feeds `{time}`
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
	const markers = parsePositions(p.markerPositions);
	const computed: Record<string, string> = {
		// One distance token per marker (1-based), camera centre → marker,
		// following the pan. `{distance}` stays the first marker's distance
		// (back-compat with existing templates).
		time:
			state.lastAt === null
				? "–"
				: formatClock((Date.now() - state.lastAt) / 1000),
		status: statusText(state, p),
	};
	for (const [i, m] of markers.entries())
		computed[`distance${i + 1}`] = formatDistance(
			distanceMeters(m.lat, m.lon, c.lat, c.lng),
		);
	if (markers[0]) computed.distance = computed.distance1;
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

/* ── Keep-history routes (server-recorded, TODO/09-map.md) ─────────── */

/** How often the runtime page re-fetches the recorded routes. */
const HISTORY_POLL_MS = 5000;

interface MapHistoryPath {
	id: string;
	name: string;
	startedAt: number;
	endedAt: number | null;
	points: { lat: number; lon: number; at: number }[];
}

/** The owner-token history endpoint this overlay polls (`null` off the
 * runtime page — the editor renders the map without history). */
function mapHistoryUrl(ctx: ElementContext): string | null {
	if (!ctx.overlayId || !ctx.token || !ctx.activeTriggers) return null;
	return (
		"/overlay/" +
		encodeURIComponent(ctx.overlayId) +
		"/map-history?token=" +
		encodeURIComponent(ctx.token)
	);
}

/** Draw the live `default` route: bold in `historyColor` with a white
 * casing, like the live trace. The runtime page renders only the `default`
 * route — segments archived by `path.end/<name>` are kept server-side,
 * not drawn. */
function drawHistory(state: MapState, paths: MapHistoryPath[]): void {
	const layer = state.historyLayer;
	layer.clearLayers();
	const path = paths.find((p) => p.name === "default" && p.endedAt === null);
	if (!path || path.points.length < 2) return;
	const ll = path.points.map((p) => [p.lat, p.lon] as [number, number]);
	const color = state.lastProps.historyColor;
	L.polyline(ll, {
		color: "#fff",
		weight: 7,
		opacity: 0.9,
		interactive: false,
		lineJoin: "round",
		lineCap: "butt",
	}).addTo(layer);
	L.polyline(ll, {
		color,
		weight: 4,
		opacity: 1,
		interactive: false,
		lineJoin: "round",
		lineCap: "round",
		title: "Route: default",
	}).addTo(layer);
}

/** One `map-history` fetch + redraw; `false` off the runtime page or on a
 * failed fetch (the poll retries, a path event triggers a fresh try). */
async function fetchHistory(state: MapState): Promise<boolean> {
	const url = mapHistoryUrl(state.ctx);
	if (!url) return false;
	try {
		const res = await fetch(url);
		if (!res.ok) return false;
		const body = (await res.json()) as { paths?: MapHistoryPath[] };
		drawHistory(state, Array.isArray(body.paths) ? body.paths : []);
		return true;
	} catch {
		return false;
	}
}

function startHistoryTimer(state: MapState): void {
	if (state.historyTimer) return;
	state.historyTimer = setInterval(() => {
		void fetchHistory(state);
	}, HISTORY_POLL_MS);
	state.historyTimer.unref?.();
	void fetchHistory(state);
}

function stopHistoryTimer(state: MapState): void {
	if (!state.historyTimer) return;
	clearInterval(state.historyTimer);
	state.historyTimer = 0;
	state.historyLayer.clearLayers();
}

/** Start/stop/restyle the history feed when `keepHistory`/`historyColor`
 * change between syncs. */
function syncHistory(state: MapState, p: LiveMapProps): void {
	if (p.keepHistory) {
		if (!state.historyTimer) startHistoryTimer(state);
		else if (state.lastProps.historyColor !== p.historyColor)
			void fetchHistory(state);
	} else if (state.historyTimer) {
		stopHistoryTimer(state);
	}
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

	// A new `centerPosition` string repoints the camera; an unparseable one
	// (e.g. an in-flight variable update) leaves the view where it is.
	const center = parsePosition(p.centerPosition);
	if (p.centerPosition !== state.centerPos && center) {
		state.centerPos = p.centerPosition;
		state.centerLat = center.lat;
		state.centerLon = center.lon;
		state.centerMarker.setLatLng([center.lat, center.lon]);
		// A prop-driven move IS a new position — stamp it (trackCenter does).
		state.lastAt = Date.now();
		map.panTo([center.lat, center.lon]);
	}
	if (p.zoom !== state.zoom) {
		state.zoom = p.zoom;
		map.setZoom(p.zoom);
	}

	// Marker list: rebuild only when the string changed; restyle when the
	// shared glyph props changed (rebuilds already carry the new style).
	const positions = parsePositions(p.markerPositions);
	if (p.markerPositions !== state.markerPositions) {
		for (const marker of state.markers) map.removeLayer(marker);
		state.markers = positions.map((pos, i) =>
			L.marker([pos.lat, pos.lon], {
				interactive: false,
				keyboard: false,
				title: "Marker",
			})
				.setIcon(
					glyphIcon(
						markerIconAt(p.markerIcons, i, DEFAULT_MARKER_ICON),
						markerColorAt(p.markerColors, i, DEFAULT_MARKER_COLOR),
						p.markerSize,
					),
				)
				.addTo(map),
		);
		state.markerPos = positions;
		state.markerPositions = p.markerPositions;
	} else if (
		p.markerIcons !== state.lastProps.markerIcons ||
		p.markerColors !== state.lastProps.markerColors ||
		p.markerSize !== state.lastProps.markerSize
	) {
		state.markers.forEach((marker, i) => {
			const pos = state.markerPos[i];
			if (pos)
				setGlyph(
					marker,
					[pos.lat, pos.lon],
					markerIconAt(p.markerIcons, i, DEFAULT_MARKER_ICON),
					markerColorAt(p.markerColors, i, DEFAULT_MARKER_COLOR),
					p.markerSize,
				);
		});
	}

	setGlyph(
		state.centerMarker,
		[state.centerLat, state.centerLon],
		p.centerIcon,
		p.centerColor,
		p.centerSize,
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
	syncHistory(state, p);
	state.lastProps = p;
}

function initMap(
	container: HTMLElement,
	props: LiveMapProps,
	elementId: string,
	ctx: ElementContext,
): MapState {
	// `safeProps` guarantees a parseable `centerPosition`; the fallback only
	// guards direct (test) calls with a raw record.
	const center =
		parsePosition(props.centerPosition) ??
		parsePosition(DEFAULT_LIVE_MAP_PROPS.centerPosition);
	const map = L.map(container, {
		zoomControl: false,
		attributionControl: false,
	}).setView([center!.lat, center!.lon], props.zoom);
	L.control
		.attribution({
			position: "topright",
		})
		.addTo(map);
	// Leaflet does not reflow when the container size changes (overlay
	// elements are drag-resizable) — invalidate the size to re-tile.
	const resizeObserver = new ResizeObserver(() => map.invalidateSize());
	resizeObserver.observe(container);

	// Glyph markers: the configured centre plus the `markerPositions` set.
	const centerMarker = L.marker([center!.lat, center!.lon], {
		interactive: false,
		keyboard: false,
	}).addTo(map);
	const markerPos = parsePositions(props.markerPositions);
	const markers = markerPos.map((pos, i) =>
		L.marker([pos.lat, pos.lon], {
			interactive: false,
			keyboard: false,
			title: "Marker",
		})
			.setIcon(
				glyphIcon(
					markerIconAt(props.markerIcons, i, DEFAULT_MARKER_ICON),
					markerColorAt(props.markerColors, i, DEFAULT_MARKER_COLOR),
					props.markerSize,
				),
			)
			.addTo(map),
	);
	// Recorded routes render below the marker panes — the layer group is
	// added first, so the polyline z-order keeps the markers on top.
	const historyLayer = L.layerGroup().addTo(map);

	const state: MapState = {
		map,
		container,
		elementId,
		resizeObserver,
		layers: {},
		provider: "",
		mapyKey: null,
		centerMarker,
		markers,
		markerPos,
		markerPositions: props.markerPositions,
		historyLayer,
		historyTimer: 0,
		centerPos: props.centerPosition,
		centerLat: center!.lat,
		centerLon: center!.lon,
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

/** Runtime trigger: a `path.end/…` event named for this element stamps the
 * centre position time, flipping `{status}` live. The element is persistent
 * — it renders all the time and only reacts; the claim itself is declined
 * (no trigger state). */
function onTrigger(
	element: OverlayElement,
	eventName: string,
	_payload: Record<string, unknown>,
	_ctx: ElementContext,
): number | undefined {
	if (!eventName.startsWith("path.end/")) return undefined;
	const state = [...maps.values()].find((s) => s.elementId === element.id);
	if (state) {
		state.lastAt = Date.now();
		refreshInfo(state);
		// The server has just archived the live route — re-fetch so the map
		// shows it without waiting for the next 5 s poll.
		if (state.lastProps.keepHistory) void fetchHistory(state);
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
						stopHistoryTimer(state);
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
	// The icon selects are grouped into "Color" (emoji) and "Single color"
	// (glyph) via `<optgroup>`. `t()` runs at render time (not module load).
	const iconGroups: ControlOption[] = [
		{
			label: t("overlay.live_map_icon_group_color"),
			options: COLOR_ICONS.map((g) => ({ value: g, label: g })),
		},
		{
			label: t("overlay.live_map_icon_group_single"),
			options: SINGLE_COLOR_ICONS.map((g) => ({ value: g, label: g })),
		},
	];
	// `markerPositions` is one bindable string (`lon,lat;lon,lat`) — the
	// marker count (and the rows below) is derived from its `";"` slots.
	// `markerIcons` / `markerColors` are parallel `";"`-separated strings,
	// index-aligned with the position slots; an empty slot uses the built-in
	// default glyph/colour.
	const posSlots = p.markerPositions ? p.markerPositions.split(";") : [];
	const iconSlots = p.markerIcons.split(";");
	const colorSlots = p.markerColors.split(";");
	const writeIconSlot = (i: number, value: string) =>
		mutate((el) => {
			const icons = String(el.props.markerIcons).split(";");
			while (icons.length <= i) icons.push("");
			icons[i] = value;
			el.props.markerIcons = icons.join(";");
		});
	const writeColorSlot = (i: number, value: string) =>
		mutate((el) => {
			const colors = String(el.props.markerColors).split(";");
			while (colors.length <= i) colors.push("");
			colors[i] = value;
			el.props.markerColors = colors.join(";");
		});
	// The whole multi-marker position set, bound so a variable can replace it.
	const markerPositionsField: Vnode = bindField(
		e,
		"props.markerPositions",
		t("overlay.live_map_marker_positions"),
		<input
			type="text"
			placeholder="lon,lat;lon,lat"
			value={p.markerPositions}
			oninput={(ev: Event) =>
				mutate((el) => {
					el.props.markerPositions = (ev.target as HTMLInputElement).value;
				})
			}
		/>,
		sp,
	);
	// One row per position slot — each marker owns its icon + colour (no
	// position input here; that lives in the bindable field above).
	const markerList: Vnode = (
		<div class="ov-field">
			<span class="ov-lbl">{t("overlay.live_map_marker_list")}</span>
			<div>
				{posSlots.map((_, i) => (
					<div class="ov-grid3" key={i}>
						<select
							class="ov-marker-icon"
							value={iconSlots[i] ?? ""}
							onchange={(ev: Event) =>
								writeIconSlot(i, (ev.target as HTMLSelectElement).value)
							}
						>
							<option value="">
								{t("overlay.live_map_marker_icon_default")}
							</option>
							{iconGroups.map((group) =>
								"options" in group ? (
									<optgroup key={group.label} label={group.label}>
										{group.options.map((o) => (
											<option value={o.value} key={o.value}>
												{o.label}
											</option>
										))}
									</optgroup>
								) : (
									<option value={group.value} key={group.value}>
										{group.label}
									</option>
								),
							)}
						</select>
						<input
							type="color"
							class="ov-marker-color"
							value={colorSlots[i] || DEFAULT_MARKER_COLOR}
							oninput={(ev: Event) =>
								writeColorSlot(i, (ev.target as HTMLInputElement).value)
							}
						/>
						<button
							class="ov-bind-chk"
							type="button"
							title={t("overlay.live_map_remove_marker")}
							aria-label={t("overlay.live_map_remove_marker")}
							onclick={() =>
								mutate((el) => {
									const slots = String(el.props.markerPositions).split(";");
									slots.splice(i, 1);
									el.props.markerPositions = slots.join(";");
									const icons = String(el.props.markerIcons).split(";");
									icons.splice(i, 1);
									el.props.markerIcons = icons.join(";");
									const colors = String(el.props.markerColors).split(";");
									colors.splice(i, 1);
									el.props.markerColors = colors.join(";");
								})
							}
						>
							<Icon name="close" class="role-icon" />
						</button>
					</div>
				))}
				<div class="ov-field-row">
					<button
						class="ov-add-marker"
						type="button"
						title={t("overlay.live_map_add_marker")}
						onclick={() =>
							mutate((el) => {
								const s = String(el.props.markerPositions);
								el.props.markerPositions = s ? `${s};` : "";
								const icons = String(el.props.markerIcons);
								el.props.markerIcons = icons ? `${icons};` : "";
								const colors = String(el.props.markerColors);
								el.props.markerColors = colors ? `${colors};` : "";
							})
						}
					>
						<Icon name="plus" class="role-icon" />
						<span>{t("overlay.live_map_add_marker")}</span>
					</button>
				</div>
			</div>
		</div>
	);
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
					path: "props.centerPosition",
					labelKey: "overlay.live_map_center_position",
					type: "text",
					value: p.centerPosition,
				},
			],
			[
				{
					path: "props.centerIcon",
					labelKey: "overlay.live_map_center_icon",
					type: "select",
					value: p.centerIcon,
					options: iconGroups,
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
			markerPositionsField,
			markerList,
			[
				{
					path: "props.markerSize",
					labelKey: "overlay.live_map_marker_size",
					type: "number",
					value: p.markerSize,
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
					path: "props.keepHistory",
					labelKey: "overlay.live_map_keep_history",
					type: "checkbox",
					value: p.keepHistory === true,
				},
			],
			...(p.keepHistory
				? ([
						[
							{
								path: "props.historyColor",
								labelKey: "overlay.live_map_history_color",
								type: "color",
								value: p.historyColor,
							},
						],
					] as FormRow[])
				: ([] as FormRow[])),
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
	if (!parsePosition(p.centerPosition))
		problems.push('centerPosition is not a valid "lon,lat" string');
	for (const [i, entry] of p.markerPositions.split(";").entries()) {
		if (!entry.trim()) continue;
		if (!parsePosition(entry))
			problems.push(`marker ${i + 1} is not a valid "lon,lat" string`);
	}
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

/** The glyph for marker `index` (one of `LIVE_MAP_ICONS`); the slot is
 * index-aligned with `markerPositions`, and a missing/empty/unknown one
 * falls back to `fallback` (the built-in default glyph). */
function markerIconAt(icons: string, index: number, fallback: string): string {
	const entry = icons.split(";")[index] ?? "";
	return LIVE_MAP_ICONS.includes(entry) ? entry : fallback;
}

/** The hex colour for marker `index`; the slot is index-aligned with
 * `markerPositions`, and a missing/empty/invalid one falls back to
 * `fallback` (the built-in default colour). */
function markerColorAt(
	colors: string,
	index: number,
	fallback: string,
): string {
	const entry = cleanHex(colors.split(";")[index] ?? "", fallback);
	return entry;
}

function safeProps(rawInput: unknown): LiveMapProps {
	const d = DEFAULT_LIVE_MAP_PROPS;
	const raw: Record<string, unknown> =
		rawInput && typeof rawInput === "object"
			? (rawInput as Record<string, unknown>)
			: {};
	const provider = raw.provider as LiveMapProvider;
	return {
		provider:
			provider === "osm" || provider === "arcgis" || provider === "mapy"
				? provider
				: d.provider,
		zoom: cleanNum(raw.zoom, d.zoom, 0, 25),
		// The raw string is kept verbatim (in-flight edits, in-progress
		// variable updates) — parsing happens at render time; an unparseable
		// value leaves the view where it is (initMap falls back to the
		// default position, syncMap keeps the current one). An empty
		// `markerPositions` means "no markers" — never the default marker.
		centerPosition: cleanStr(raw.centerPosition, 50) || d.centerPosition,
		mapyKey: cleanStr(raw.mapyKey, 200),
		centerIcon: iconOf(raw.centerIcon, d.centerIcon),
		centerColor: cleanHex(raw.centerColor, d.centerColor),
		centerSize: cleanNum(raw.centerSize, d.centerSize, 8, 96),
		markerPositions: cleanStr(raw.markerPositions, 1000),
		markerIcons: cleanStr(raw.markerIcons, 1000),
		markerColors: cleanStr(raw.markerColors, 1000),
		markerSize: cleanNum(raw.markerSize, d.markerSize, 8, 96),
		showInfo: cleanBool(raw.showInfo),
		infoTemplate: cleanStr(raw.infoTemplate, 400) || d.infoTemplate,
		infoFontSize: cleanNum(raw.infoFontSize, d.infoFontSize, 8, 96),
		infoPadding: cleanNum(raw.infoPadding, d.infoPadding, 0, 48),
		infoColor: cleanHex(raw.infoColor, d.infoColor),
		infoBackground: cleanHex(raw.infoBackground, d.infoBackground),
		status: cleanStr(raw.status, 100),
		liveThreshold: cleanNum(raw.liveThreshold, d.liveThreshold, 0, 3600),
		keepHistory: cleanBool(raw.keepHistory),
		historyColor: cleanHex(raw.historyColor, d.historyColor),
	};
}

export const liveMapElement: OverlayElementDef & OverlayElementSchema = {
	type: "live_map",
	category: "widgets",

	labelKey: "overlay.add_live_map",
	icon: () => <Icon name="target" class="role-icon" />,
	order: 100,
	defaultProps: { ...DEFAULT_LIVE_MAP_PROPS },
	propKeys: [
		"provider",
		"zoom",
		"centerPosition",
		"mapyKey",
		"centerIcon",
		"centerColor",
		"centerSize",
		"markerPositions",
		"markerIcons",
		"markerColors",
		"markerSize",
		"showInfo",
		"infoTemplate",
		"infoFontSize",
		"infoPadding",
		"infoColor",
		"infoBackground",
		"status",
		"liveThreshold",
		"keepHistory",
		"historyColor",
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
		return {
			provider: read.oneOf("provider", ["osm", "arcgis", "mapy"], d.provider),
			zoom: read.num("zoom", d.zoom, 0, 25),
			// Kept verbatim (render-time parsing); an empty/missing value
			// falls back to the default position.
			centerPosition:
				read.str("centerPosition", d.centerPosition, 50) || d.centerPosition,
			mapyKey: read.str("mapyKey", d.mapyKey, 200),
			centerIcon: iconOf(
				read.str("centerIcon", d.centerIcon, 10),
				d.centerIcon,
			),
			centerColor: read.hex("centerColor", d.centerColor),
			centerSize: read.num("centerSize", d.centerSize, 8, 96),
			// A stored value is kept verbatim — including the empty string
			// (no markers), which must not fall back to the default marker.
			markerPositions: read.str("markerPositions", d.markerPositions, 1000),
			// Kept verbatim (like markerPositions): slots are index-aligned
			// and an empty slot must mean "use the built-in default".
			markerIcons: read.str("markerIcons", d.markerIcons, 1000),
			markerColors: read.str("markerColors", d.markerColors, 1000),
			markerSize: read.num("markerSize", d.markerSize, 8, 96),
			showInfo: read.bool("showInfo"),
			infoTemplate: read.str("infoTemplate", d.infoTemplate, 400),
			infoFontSize: read.num("infoFontSize", d.infoFontSize, 8, 96),
			infoPadding: read.num("infoPadding", d.infoPadding, 0, 48),
			infoColor: read.hex("infoColor", d.infoColor),
			infoBackground: read.hex("infoBackground", d.infoBackground),
			status: read.str("status", d.status, 100),
			liveThreshold: read.num("liveThreshold", d.liveThreshold, 0, 3600),
			keepHistory: read.bool("keepHistory"),
			historyColor: read.hex("historyColor", d.historyColor),
		};
	},
};
