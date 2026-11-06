/** @jsx m */
/*
 * Interactive Leaflet map. Tile providers: OpenStreetMap (default), ArcGIS
 * satellite, and Mapy.com tourist (only when an API key is set). A custom
 * top-right control switches providers; the configured centre carries a
 * circle marker.
 *
 * `startPosition` places a marker (e.g. the route start); with
 * `showDistance` on, a badge below the map tracks the geodesic distance
 * from it to the map centre as the camera moves.
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
import { cleanBool, cleanHex, cleanNum, cleanStr } from "./schema_utils";

/* ── Props ────────────────────────────────────────────────────────── */

export type LiveMapProvider = "osm" | "arcgis" | "mapy";

export interface LiveMapProps {
	provider: LiveMapProvider;
	zoom: number;
	centerLat: number;
	centerLon: number;
	mapyKey: string;
	/** Fill colour of the circle marking the current map centre. */
	markerColor: string;
	/** Radius of the current-centre circle marker, in pixels. */
	markerSize: number;
	/** Marker position, e.g. the route start point. */
	startPosition: { lat: number; lon: number };
	/** Draw a badge with the geodesic distance from the start position to
	 * the map centre; the badge follows the camera while panning. */
	showDistance: boolean;
	/** Distance-badge font size, in pixels. */
	distanceFontSize: number;
	/** Distance-badge padding, in pixels. */
	distancePadding: number;
	/** Distance-badge text colour. */
	distanceColor: string;
	/** Distance-badge background colour. */
	distanceBackground: string;
}

export const DEFAULT_LIVE_MAP_PROPS: Required<LiveMapProps> = {
	provider: "osm",
	zoom: 15,
	centerLat: 50.1635,
	centerLon: 12.4034,
	mapyKey: "",
	markerColor: "#3a7afe",
	markerSize: 8,
	startPosition: { lat: 50.1635, lon: 12.4034 },
	showDistance: false,
	distanceFontSize: 13,
	distancePadding: 6,
	distanceColor: "#ffffff",
	distanceBackground: "#000000",
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
    /* The distance badge is a full-width row BELOW the map, right-aligned.
     * Font size, padding, and colours are per-element props (inline). */
    .live-map-distance {
      box-sizing: border-box; width: 100%; text-align: right;
      border-radius: 4px; white-space: nowrap;
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
	resizeObserver: ResizeObserver;
	// One tile layer per available provider; `layers[provider]` is the
	// visible one, so switching only toggles visibility.
	layers: Partial<Record<LiveMapProvider, any>>;
	// `""` until the first sync has picked a provider.
	provider: LiveMapProvider | "";
	// `null` until the first sync has built the layer set.
	mapyKey: string | null;
	// Circle marker pinning the configured map centre.
	centerMarker: any;
	centerLat: number;
	centerLon: number;
	markerColor: string;
	markerSize: number;
	zoom: number;
	showDistance: boolean;
	// Distance-badge node rendered below the map; `null` until (re)mounted.
	badge: HTMLElement | null;
	// Refreshes the badge from the live camera centre.
	updateBadge: null | (() => void);
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
			maxNativeZoom: 19,
			maxZoom: 25,
			minZoom: 0,
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

/** Add/remove the start marker to follow the `showDistance` prop. The
 * distance badge is Mithril-rendered below the map (see `draw`) and is
 * refreshed by the map's move/zoom events via `state.badge`. */
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
		map.panTo([p.centerLat, p.centerLon]);
		state.centerMarker.setLatLng([p.centerLat, p.centerLon]);
	}
	if (p.zoom !== state.zoom) {
		state.zoom = p.zoom;
		map.setZoom(p.zoom);
	}
	if (
		p.markerColor !== state.markerColor ||
		p.markerSize !== state.markerSize
	) {
		state.markerColor = p.markerColor;
		state.markerSize = p.markerSize;
		state.centerMarker.setStyle({ fillColor: p.markerColor });
		state.centerMarker.setRadius(p.markerSize);
	}

	syncDistance(state, p);
}

function initMap(container: HTMLElement, props: LiveMapProps): MapState {
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

	// A circle marker pinning the configured map centre.
	const centerMarker = L.circleMarker([props.centerLat, props.centerLon], {
		radius: props.markerSize,
		color: "#ffffff",
		weight: 2,
		fillColor: props.markerColor,
		fillOpacity: 0.85,
	}).addTo(map);

	const state: MapState = {
		map,
		resizeObserver,
		layers: {},
		container,
		centerMarker,
		provider: "",
		mapyKey: null,
		centerLat: props.centerLat,
		centerLon: props.centerLon,
		markerColor: props.markerColor,
		markerSize: props.markerSize,
		zoom: props.zoom,
		showDistance: false,
		badge: null,
		updateBadge: null,
		lastProps: props,
	};

	// Reads `state.lastProps` so the badge follows start-position edits.
	const updateBadge = (): void => {
		const badge = state.badge;
		if (!badge) return;
		const c = map.getCenter();
		const s = state.lastProps.startPosition;
		badge.innerHTML = `<b>${t("overlay.live_map_distance")}</b> ${formatDistance(
			distanceMeters(s.lat, s.lon, c.lat, c.lng),
		)}`;
	};
	state.updateBadge = updateBadge;
	map.on("movestart", updateBadge);
	map.on("movend", updateBadge);
	map.on("zoomend", updateBadge);
	// The badge may already be in the DOM — Mithril renders it before the
	// async Leaflet load finishes.
	state.badge = (container.parentElement?.querySelector(
		":scope > .live-map-distance",
	) ?? null) as HTMLElement | null;
	if (state.badge) updateBadge();

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
		zoom: cleanNum(raw.zoom, d.zoom, 0, 25),
		centerLat: cleanNum(raw.centerLat, d.centerLat, -90, 90),
		centerLon: cleanNum(raw.centerLon, d.centerLon, -180, 180),
		mapyKey: cleanStr(raw.mapyKey, 200),
		markerColor: cleanHex(raw.markerColor, d.markerColor),
		markerSize: cleanNum(raw.markerSize, d.markerSize, 1, 100),
		startPosition: {
			lat: cleanNum(rawStart.lat, d.startPosition.lat, -90, 90),
			lon: cleanNum(rawStart.lon, d.startPosition.lon, -180, 180),
		},
		showDistance: cleanBool(raw.showDistance),
		distanceFontSize: cleanNum(raw.distanceFontSize, d.distanceFontSize, 8, 96),
		distancePadding: cleanNum(raw.distancePadding, d.distancePadding, 0, 48),
		distanceColor: cleanHex(raw.distanceColor, d.distanceColor),
		distanceBackground: cleanHex(raw.distanceBackground, d.distanceBackground),
	};
}

/* ── Mithril draw ─────────────────────────────────────────────────── */

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const p = safeProps(element.props);
	// The badge is a sibling of the map div — their shared state lives on
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
						maps.set(container, initMap(container, safeProps(element.props)));
					});
				},
				// Prop changes re-render into the same DOM node (oncreate does
				// not re-run) — apply them to the live map in place.
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
						state.resizeObserver.disconnect();
						state.map.remove();
					}
				},
			}),
			// The distance badge sits BELOW the map — the map's move/zoom
			// events refresh its text via `state.badge` (see `initMap`).
			p.showDistance
				? m("div", {
						class: "live-map-distance",
						style: {
							fontSize: `${p.distanceFontSize}px`,
							padding: `${p.distancePadding}px`,
							color: p.distanceColor,
							background: p.distanceBackground,
						},
						oncreate: (vnode) => {
							const st = stateFor(vnode.dom as HTMLElement);
							if (st) {
								st.badge = vnode.dom as HTMLElement;
								st.updateBadge?.();
							}
						},
						onupdate: (vnode) => {
							const st = stateFor(vnode.dom as HTMLElement);
							if (st && st.badge !== vnode.dom) {
								st.badge = vnode.dom as HTMLElement;
								st.updateBadge?.();
							}
						},
						onremove: (vnode) => {
							const st = stateFor(vnode.dom as HTMLElement);
							if (st) st.badge = null;
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
	const num = (
		key:
			| "zoom"
			| "centerLat"
			| "centerLon"
			| "markerSize"
			| "distanceFontSize"
			| "distancePadding"
			| "startPosition",
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
				step={
					key === "zoom" ||
					key === "distanceFontSize" ||
					key === "distancePadding" ||
					key === "markerSize"
						? 1
						: 0.0001
				}
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
			{num("zoom", null, t("overlay.live_map_zoom"), 0, 25)}
			{num("centerLat", null, t("overlay.live_map_center_lat"), -90, 90)}
			{num("centerLon", null, t("overlay.live_map_center_lon"), -180, 180)}
			<div class="ov-grid2">
				{bindField(
					e,
					"props.markerColor",
					t("overlay.live_map_marker_color"),
					<input
						type="color"
						value={p.markerColor}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.markerColor = (ev.target as HTMLInputElement).value;
							})
						}
					/>,
					sp,
				)}
				{num("markerSize", null, t("overlay.live_map_marker_size"), 1, 100)}
			</div>
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
			{p.showDistance && (
				<>
					<div class="ov-grid2">
						{num(
							"distanceFontSize",
							null,
							t("overlay.live_map_distance_font_size"),
							8,
							96,
						)}
						{num(
							"distancePadding",
							null,
							t("overlay.live_map_distance_padding"),
							0,
							48,
						)}
					</div>
					<div class="ov-grid2">
						{bindField(
							e,
							"props.distanceColor",
							t("overlay.live_map_distance_color"),
							<input
								type="color"
								value={p.distanceColor}
								oninput={(ev: Event) =>
									mutate((el) => {
										el.props.distanceColor = (
											ev.target as HTMLInputElement
										).value;
									})
								}
							/>,
							sp,
						)}
						{bindField(
							e,
							"props.distanceBackground",
							t("overlay.live_map_distance_background"),
							<input
								type="color"
								value={p.distanceBackground}
								oninput={(ev: Event) =>
									mutate((el) => {
										el.props.distanceBackground = (
											ev.target as HTMLInputElement
										).value;
									})
								}
							/>,
							sp,
						)}
					</div>
				</>
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
		"zoom",
		"centerLat",
		"centerLon",
		"mapyKey",
		"markerColor",
		"markerSize",
		"startPosition",
		"showDistance",
		"distanceFontSize",
		"distancePadding",
		"distanceColor",
		"distanceBackground",
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
			zoom: read.num("zoom", d.zoom, 0, 25),
			centerLat: read.num("centerLat", d.centerLat, -90, 90),
			centerLon: read.num("centerLon", d.centerLon, -180, 180),
			mapyKey: read.str("mapyKey", d.mapyKey, 200),
			markerColor: read.hex("markerColor", d.markerColor),
			markerSize: read.num("markerSize", d.markerSize, 1, 100),
			// No object reader in PropReaders — complete a partial object from the defaults.
			startPosition: {
				lat: cleanNum(rawStart?.lat, d.startPosition.lat, -90, 90),
				lon: cleanNum(rawStart?.lon, d.startPosition.lon, -180, 180),
			},
			showDistance: read.bool("showDistance"),
			distanceFontSize: read.num("distanceFontSize", d.distanceFontSize, 8, 96),
			distancePadding: read.num("distancePadding", d.distancePadding, 0, 48),
			distanceColor: read.hex("distanceColor", d.distanceColor),
			distanceBackground: read.hex("distanceBackground", d.distanceBackground),
		};
	},
};
