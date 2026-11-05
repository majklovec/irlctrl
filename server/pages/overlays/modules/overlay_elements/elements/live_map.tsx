/** @jsx m */
/*
 * Interactive Leaflet map. Tile providers: OpenStreetMap (default), ArcGIS
 * satellite, and Mapy.com tourist (only when an API key is set). A custom
 * top-right control switches providers and toggles a B&W filter — the filter
 * is scoped to the tile pane only, so markers (start position) stay coloured.
 *
 * `startPosition` places a marker (e.g. the route start); with
 * `showDistance` on, a badge tracks the geodesic distance from it to the map
 * centre as the camera moves.
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
import { bindField } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { cleanBool, cleanNum, cleanStr } from "./schema_utils";

/* ── Props ────────────────────────────────────────────────────────── */

export type LiveMapProvider = "osm" | "arcgis" | "mapy";

export interface LiveMapProps {
	provider: LiveMapProvider;
	blackGrayscale: boolean;
	zoom: number;
	centerLat: number;
	centerLon: number;
	mapyKey: string;
	/** Marker position, e.g. the route start point. */
	startPosition: { lat: number; lon: number };
	/** Draw a badge with the geodesic distance from the start position to
	 * the map centre; the badge follows the camera while panning. */
	showDistance: boolean;
}

export const DEFAULT_LIVE_MAP_PROPS: Required<LiveMapProps> = {
	provider: "osm",
	blackGrayscale: false,
	zoom: 15,
	centerLat: 50.1635,
	centerLon: 12.4034,
	mapyKey: "",
	startPosition: { lat: 50.1635, lon: 12.4034 },
	showDistance: false,
};

/** On-map control names stay English (spec) — the Leaflet control is built
 * with raw HTML outside the UI i18n cycle. */
const PROVIDER_NAME: Record<LiveMapProvider, string> = {
	osm: "Map",
	arcgis: "Satellite",
	mapy: "Tourist",
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
			return "&copy; Esri, Maxar, Earthstar Geographics";
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
    .bw.leaflet-container .leaflet-tile-pane {
      filter: grayscale(100%) invert(1);
    }
    .bw.leaflet-container { background: #0e100f; }
    .live-map-distance {
      background: rgba(0,0,0,.7); color: #fff; font-size: 13px;
      padding: 4px 10px; border-radius: 4px; white-space: nowrap;
    }
    .live-map-distance b { font-weight: 600; }
    /* The start marker is plain (not a Leaflet image marker) so the B&W tile
     * filter never reaches it. */
    #live-map-start path {
      fill: #D6007F; stroke: #fff; stroke-width: 1.5;
    }
  `;
	document.head.appendChild(s);
}

/* ── Geodesic distance (haversine, metres) ─────────────────────────── */

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

/* ── Map initialisation ───────────────────────────────────────────── */

interface MapState {
	map: any;
	container: HTMLElement;
	// One tile layer per available provider; `layers[provider]` is the
	// visible one, so switching only toggles visibility.
	layers: Partial<Record<LiveMapProvider, any>>;
	// `""` until the first sync has picked a provider.
	provider: LiveMapProvider | "";
	mapyKey: string;
	bw: boolean;
	centerLat: number;
	centerLon: number;
	zoom: number;
	showDistance: boolean;
	// Latest resolved props; the distance badge reads from it live.
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
			maxZoom: 19,
			attribution: providerAttribution(key),
			opacity: 1,
		},
	);
}

const PROVIDER_ORDER: LiveMapProvider[] = ["osm", "arcgis", "mapy"];

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

/** Add/remove the start marker and the live distance badge to follow the
 * `showDistance` prop. */
function syncDistance(state: MapState, p: LiveMapProps): void {
	const { map } = state;
	state.showDistance = p.showDistance;
	const want = state.showDistance;
	const have = Boolean(map._liveMapStartMarker);
	if (want && !have) {
		const icon = L.divIcon({
			className: "",
			iconSize: [34, 44],
			iconAnchor: [17, 42],
			html: '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44"><path d="M17 1C8.7 1 2 7.7 2 16c0 11 15 27 15 27s15-16 15-27C32 7.7 25.3 1 17 1z"/><circle cx="17" cy="16" r="6" fill="#fff"/></svg>',
		});
		map._liveMapStartMarker = L.marker(
			[p.startPosition.lat, p.startPosition.lon],
			{ icon, title: "Start position" },
		).addTo(map);
	} else if (!want && have) {
		map.removeLayer(map._liveMapStartMarker);
		map._liveMapStartMarker = null;
	}
	if (want && map._liveMapStartMarker) {
		map._liveMapStartMarker.setLatLng([
			p.startPosition.lat,
			p.startPosition.lon,
		]);
		map._liveMapStartMarker._icon?.setAttribute("id", "live-map-start");
	}
	if (want && !map._liveMapBadge) {
		const badge = L.DomUtil.create("div", "live-map-distance");
		// Reads `state.lastProps` so the badge follows start-position edits.
		const updateBadge = (): void => {
			const c = map.getCenter();
			const s = state.lastProps.startPosition;
			badge.innerHTML = `<b>Distance</b> ${formatDistance(
				distanceMeters(s.lat, s.lon, c.lat, c.lng),
			)}`;
		};
		map._liveMapBadge = badge;
		map.on("movestart", updateBadge);
		map.on("movend", updateBadge);
		map.on("zoomend", updateBadge);
		const dctrl = L.control({ position: "bottomright" });
		dctrl.onAdd = () => badge;
		map._liveMapBadgeCtrl = dctrl.addTo(map);
	} else if (!want && map._liveMapBadgeCtrl) {
		map.removeControl(map._liveMapBadgeCtrl);
		map._liveMapBadgeCtrl = null;
		map._liveMapBadge = null;
	}
}

/** Apply a resolved props object to the live map in place — the single place
 * props changes become visible. */
function syncMap(state: MapState, p: LiveMapProps): void {
	const { map } = state;

	// Tile layer URLs embed the mapy key — rebuild when it changes.
	if (state.mapyKey !== p.mapyKey) {
		for (const k of Object.keys(state.layers) as LiveMapProvider[])
			map.removeLayer(state.layers[k]);
		state.layers = {};
		for (const k of Object.keys(PROVIDER_NAME) as LiveMapProvider[]) {
			if (k === "mapy" && !p.mapyKey) continue;
			state.layers[k] = makeTileLayer(k, p.mapyKey);
		}
		state.mapyKey = p.mapyKey;
		state.provider = "";
	}
	setProvider(state, p);

	state.bw = p.blackGrayscale;
	state.container.classList.toggle("bw", state.bw);

	if (p.centerLat !== state.centerLat || p.centerLon !== state.centerLon) {
		state.centerLat = p.centerLat;
		state.centerLon = p.centerLon;
		map.panTo([p.centerLat, p.centerLon]);
	}
	if (p.zoom !== state.zoom) {
		state.zoom = p.zoom;
		map.setZoom(p.zoom);
	}

	syncDistance(state, p);
}

function initMap(container: HTMLElement, props: LiveMapProps): MapState {
	const map = L.map(container, { zoomControl: false }).setView(
		[props.centerLat, props.centerLon],
		props.zoom,
	);

	const state: MapState = {
		map,
		layers: {},
		container,
		bw: false,
		provider: "",
		mapyKey: props.mapyKey,
		centerLat: props.centerLat,
		centerLon: props.centerLon,
		zoom: props.zoom,
		showDistance: false,
		lastProps: props,
	};

	state.lastProps = props;
	syncMap(state, props);
	return state;
}

/** Runtime-safe prop view: coerces a (resolved) props record to the full
 * LiveMapProps shape. Mirrors `normalizeProps` (the server normalizes on
 * save, binding values resolve at render time) so a partial or stale record
 * can't break the map. */
function safeProps(raw: Record<string, unknown>): LiveMapProps {
	const d = DEFAULT_LIVE_MAP_PROPS;
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
		blackGrayscale: cleanBool(raw.blackGrayscale),
		zoom: cleanNum(raw.zoom, d.zoom, 1, 19),
		centerLat: cleanNum(raw.centerLat, d.centerLat, -90, 90),
		centerLon: cleanNum(raw.centerLon, d.centerLon, -180, 180),
		mapyKey: cleanStr(raw.mapyKey, 200),
		startPosition: {
			lat: cleanNum(rawStart.lat, d.startPosition.lat, -90, 90),
			lon: cleanNum(rawStart.lon, d.startPosition.lon, -180, 180),
		},
		showDistance: cleanBool(raw.showDistance),
	};
}

/* ── Mithril draw ─────────────────────────────────────────────────── */

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	return m("div", {
		style: { width: "100%", height: "100%" },
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
				// `element.props` is mutated in place, so this is the latest
				// state even if props changed while Leaflet was loading.
				maps.set(container, initMap(container, safeProps(element.props)));
			});
		},
		// Prop changes re-render into the same DOM node (oncreate does not
		// re-run) — apply them to the live map in place.
		onupdate: (vnode) => {
			const state = maps.get(vnode.dom as HTMLElement);
			if (state) syncMap(state, safeProps(element.props));
		},
		onremove: (vnode) => {
			const container = vnode.dom as HTMLElement;
			starting.delete(container);
			const state = maps.get(container);
			if (state) {
				maps.delete(container);
				state.map.remove();
			}
		},
	});
}

/* ── Edit form ────────────────────────────────────────────────────── */

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = safeProps(e.props);
	const sp = { mutate, variables };
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
	return (
		<>
			{bindField(
				e,
				"props.provider",
				t("overlay.live_map_provider"),
				<select
					value={p.provider}
					onchange={(ev: Event) =>
						mutate((el) => {
							el.props.provider = (ev.target as HTMLSelectElement).value;
						})
					}
				>
					<option value="osm">{t("overlay.live_map_provider.osm")}</option>
					<option value="arcgis">
						{t("overlay.live_map_provider.arcgis")}
					</option>
					<option value="mapy">{t("overlay.live_map_provider.mapy")}</option>
				</select>,
				sp,
			)}
			{bindField(
				e,
				"props.blackGrayscale",
				t("overlay.live_map_bw"),
				<input
					type="checkbox"
					checked={p.blackGrayscale === true}
					onchange={(ev: Event) =>
						mutate((el) => {
							el.props.blackGrayscale = (ev.target as HTMLInputElement).checked;
						})
					}
				/>,
				sp,
			)}
			{num("zoom", null, t("overlay.live_map_zoom"), 1, 19)}
			{num("centerLat", null, t("overlay.live_map_center_lat"), -90, 90)}
			{num("centerLon", null, t("overlay.live_map_center_lon"), -180, 180)}
			<div class="ov-grid2">
				{num("startPosition", "lat", t("overlay.live_map_start_lat"), -90, 90)}
				{num(
					"startPosition",
					"lon",
					t("overlay.live_map_start_lon"),
					-180,
					180,
				)}
			</div>
			{bindField(
				e,
				"props.showDistance",
				t("overlay.live_map_show_distance"),
				<input
					type="checkbox"
					checked={p.showDistance === true}
					onchange={(ev: Event) =>
						mutate((el) => {
							el.props.showDistance = (ev.target as HTMLInputElement).checked;
						})
					}
				/>,
				sp,
			)}
			{bindField(
				e,
				"props.mapyKey",
				t("overlay.live_map_mapy_key"),
				<input
					type="text"
					value={p.mapyKey}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.mapyKey = (ev.target as HTMLInputElement).value;
						})
					}
				/>,
				sp,
			)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const p = e.props as Partial<LiveMapProps>;
	if (typeof p.centerLat !== "number" || p.centerLat < -90 || p.centerLat > 90)
		problems.push("centerLat out of range (-90–90)");
	if (
		typeof p.centerLon !== "number" ||
		p.centerLon < -180 ||
		p.centerLon > 180
	)
		problems.push("centerLon out of range (-180–180)");
	const sp = (p.startPosition ?? {}) as { lat?: unknown; lon?: unknown };
	if (
		typeof sp.lat !== "number" ||
		sp.lat < -90 ||
		sp.lat > 90 ||
		typeof sp.lon !== "number" ||
		sp.lon < -180 ||
		sp.lon > 180
	)
		problems.push("startPosition out of range");
	return problems;
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
		"blackGrayscale",
		"zoom",
		"centerLat",
		"centerLon",
		"mapyKey",
		"startPosition",
		"showDistance",
	],
	defaultSize: { width: 640, height: 420 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(props, read) {
		const d = DEFAULT_LIVE_MAP_PROPS;
		const rawStart = props.startPosition as
			| { lat?: unknown; lon?: unknown }
			| undefined;
		return {
			provider: read.oneOf("provider", ["osm", "arcgis", "mapy"], d.provider),
			blackGrayscale: read.bool("blackGrayscale"),
			zoom: read.num("zoom", d.zoom, 1, 19),
			centerLat: read.num("centerLat", d.centerLat, -90, 90),
			centerLon: read.num("centerLon", d.centerLon, -180, 180),
			mapyKey: read.str("mapyKey", d.mapyKey, 200),
			// No object reader in PropReaders — complete a partial object from the defaults.
			startPosition: {
				lat: cleanNum(rawStart?.lat, d.startPosition.lat, -90, 90),
				lon: cleanNum(rawStart?.lon, d.startPosition.lon, -180, 180),
			},
			showDistance: read.bool("showDistance"),
		};
	},
};
