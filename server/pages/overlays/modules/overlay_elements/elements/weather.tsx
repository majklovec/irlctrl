/** @jsx m */
/*
 * Weather widget — a self-contained live weather card/pill fed by MET
 * Norway's open forecast API (no API key, CORS-enabled). The element fetches
 * its own location in the browser (editor and OBS runtime alike) on an
 * interval, so there is no server dependency. The WMO weather code maps to a
 * text glyph + label; temperature, wind and humidity are optional.
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { numProp, strProp } from "@ui/overlay/element";
import { bindField } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import { DEFAULT_WEATHER_PROPS } from "../overlay_schema";

const MET_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
/** MET Norway's terms require a User-Agent that identifies the app. */
const MET_UA = "irlctrl-overlay/1.0 (contact: local)";

/** A WMO weather code → [glyph, human label]. */
const WMO: Record<number, [string, string]> = {
	0: ["☀", "clear"],
	1: ["☀", "mainly clear"],
	2: ["⛅", "partly cloudy"],
	3: ["☁", "overcast"],
	45: ["🌫", "fog"],
	48: ["🌫", "rime fog"],
	51: ["🌦", "light drizzle"],
	53: ["🌦", "drizzle"],
	55: ["🌧", "heavy drizzle"],
	56: ["🌧", "freezing drizzle"],
	57: ["🌧", "freezing drizzle"],
	61: ["🌧", "light rain"],
	63: ["🌧", "rain"],
	65: ["🌧", "heavy rain"],
	66: ["🌧", "freezing rain"],
	67: ["🌧", "freezing rain"],
	71: ["🌨", "light snow"],
	73: ["🌨", "snow"],
	75: ["🌨", "heavy snow"],
	77: ["🌨", "snow grains"],
	80: ["🌧", "light showers"],
	81: ["🌧", "showers"],
	82: ["⛈", "violent showers"],
	85: ["🌨", "snow showers"],
	86: ["🌨", "heavy snow showers"],
	95: ["⛈", "thunderstorm"],
	96: ["⛈", "thunder, hail"],
	99: ["⛈", "thunder, hail"],
};

interface WeatherData {
	symbol: string;
	label: string;
	temp: number;
	wind: number;
	humidity: number;
}

interface WeatherFetchState {
	data: WeatherData | undefined;
	loading: boolean;
	error: string;
	timer: ReturnType<typeof setInterval>;
	fetching: boolean;
	/** The current refresh period (ms); restarted when the prop changes. */
	every: number;
}

/** Fetch + render the weather for one element; owns its refresh interval. */
const WeatherFetch: m.Component<
	{
		latitude: number;
		longitude: number;
		props: Record<string, unknown>;
	},
	WeatherFetchState
> = {
	oncreate(vnode) {
		vnode.state.data = undefined;
		vnode.state.loading = true;
		vnode.state.error = "";
		vnode.state.fetching = false;
		vnode.state.every = numProp(vnode.attrs.props, "refreshSec", 900) * 1000;
		vnode.state.timer = setInterval(
			() => void refresh(vnode),
			vnode.state.every,
		);
		void refresh(vnode);
	},
	onupdate(vnode) {
		// The refresh period is a prop; restart the interval if it changed.
		const every = numProp(vnode.attrs.props, "refreshSec", 900) * 1000;
		if (vnode.state.every !== every) {
			clearInterval(vnode.state.timer);
			vnode.state.timer = setInterval(() => void refresh(vnode), every);
			vnode.state.every = every;
		}
	},
	onremove(vnode) {
		clearInterval(vnode.state.timer);
	},
	view(vnode) {
		return render(vnode.attrs.props, vnode.state.data);
	},
};

async function refresh(
	vnode: m.Vnode<
		{ latitude: number; longitude: number; props: Record<string, unknown> },
		WeatherFetchState
	>,
): Promise<void> {
	const s = vnode.state;
	if (s.fetching) return;
	s.fetching = true;
	try {
		const url = `${MET_URL}?lat=${vnode.attrs.latitude}&lon=${vnode.attrs.longitude}`;
		const res = await fetch(url, { headers: { "User-Agent": MET_UA } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as {
			properties: {
				timeseries: Array<{
					data: {
						instant: {
							details: {
								air_temperature: number;
								relative_humidity: number;
								wind_speed: number;
							};
						};
						next_1_hours?: { summary: { symbol: { code: string } } };
					};
				}>;
			};
		};
		const now = json.properties.timeseries[0];
		const d = now.data.instant.details;
		const code = now.data.next_1_hours?.summary?.symbol?.code
			? Number(
					now.data.next_1_hours?.summary?.symbol?.code?.split("-")?.[1],
			  )
			: 0;
		const [symbol, label] = WMO[code] ?? ["🌡", "unknown"];
		s.data = {
			symbol,
			label,
			temp: d.air_temperature,
			wind: d.wind_speed,
			humidity: d.relative_humidity,
		};
		s.error = "";
	} catch (err) {
		s.error = err instanceof Error ? err.message : "fetch failed";
	} finally {
		s.fetching = false;
		s.loading = false;
		m.redraw();
	}
}

function render(p: Record<string, unknown>, data: WeatherData | undefined): Vnode {
	const format = strProp(p, "format", "card");
	const color = strProp(p, "color", "#ffffff");
	const bg = strProp(p, "background", "#1f2937");
	const accent = strProp(p, "accent", "#38bdf8");
	const radius = numProp(p, "radius", 12);
	const fontSize = numProp(p, "fontSize", 24);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
	const showTemp = p.showTemp === true;
	const showWind = p.showWind === true;
	const showHumidity = p.showHumidity === true;
	const place = strProp(p, "place", "");

	const isPill = format === "pill";
	const inner: Vnode[] = [];
	if (data) {
		inner.push(
			m("span", { key: "sym", style: { fontSize: `${Math.round(fontSize * 1.2)}px`, lineHeight: 1 } }, data.symbol),
		);
		if (showTemp)
			inner.push(
				m("span", { key: "t", style: { fontWeight: "700" } }, `${Math.round(data.temp)}°`),
			);
		if (!isPill) {
			if (showWind)
				inner.push(
					m("span", { key: "w", style: { opacity: "0.8" } }, `${Math.round(data.wind * 3.6)} km/h`),
				);
			if (showHumidity)
				inner.push(
					m("span", { key: "h", style: { opacity: "0.8" } }, `${Math.round(data.humidity)}%`),
				);
		}
	}

	const sub: Vnode[] = [];
	if (place) sub.push(m("span", { key: "p" }, place));
	if (data && !isPill) sub.push(m("span", { key: "l" }, data.label));

	return (
		<div
			style={{
				width: "100%",
				height: "100%",
				boxSizing: "border-box",
				display: "flex",
				flexDirection: isPill ? "row" : "column",
				alignItems: "center",
				justifyContent: isPill ? "center" : "center",
				gap: isPill ? "10px" : "4px",
				padding: isPill ? `${fontSize * 0.4}px ${fontSize * 0.7}px` : `${fontSize * 0.4}px`,
				background: bg,
				border: `1px solid ${accent}`,
				borderRadius: `${radius}px`,
				color,
				fontFamily,
				fontSize: `${fontSize}px`,
			}}
		>
			<div
				style={{
					display: "flex",
					flexDirection: isPill ? "row" : "column",
					alignItems: "center",
					justifyContent: "center",
					gap: "6px",
				}}
			>
				{inner}
			</div>
			{sub.length > 0 && (
				<div style={{ display: "flex", gap: "8px", opacity: "0.85", fontSize: `${Math.round(fontSize * 0.7)}px` }}>
					{sub}
				</div>
			)}
		</div>
	);
}

function draw(element: OverlayElement, _ctx: ElementContext): Vnode<any, any> {
	const p = element.props;
	return m(WeatherFetch, {
		latitude: numProp(p, "latitude", DEFAULT_WEATHER_PROPS.latitude),
		longitude: numProp(p, "longitude", DEFAULT_WEATHER_PROPS.longitude),
		props: p,
	});
}

/** Fills the latitude/longitude inputs with the browser's current position. */
const GeoFillButton: m.Component<
	{ onFill: (lat: number, lon: number) => void },
	{ locating: boolean; error: string }
> = {
	oncreate(vnode) {
		vnode.state = { locating: false, error: "" };
	},
	view(vnode) {
		const s = vnode.state;
		return (
			<div class="ov-field-row">
				<button
					class="ov-geofill"
					type="button"
					disabled={s.locating}
					onclick={() => {
						if (!navigator.geolocation) {
							s.error = t("overlay.weather_geo_error");
							m.redraw();
							return;
						}
						s.locating = true;
						s.error = "";
						m.redraw();
						navigator.geolocation.getCurrentPosition(
							(pos) => {
								s.locating = false;
								vnode.attrs.onFill(pos.coords.latitude, pos.coords.longitude);
								m.redraw();
							},
							() => {
								s.locating = false;
								s.error = t("overlay.weather_geo_error");
								m.redraw();
							},
						);
					}}
				>
					<Icon name="target" class="role-icon" />
					{s.locating ? t("overlay.weather_geo_locating") : t("overlay.weather_geo_use")}
				</button>
				{s.error && <span class="ov-geofill-err">{s.error}</span>}
			</div>
		);
	},
};

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	const setBool = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).checked;
		});
	return (
		<>
			<div class="ov-grid2">
				{bindField(e, "props.latitude", t("overlay.weather_latitude"),
					<input type="number" step={0.0001} value={numProp(p, "latitude", 50.0755)} oninput={setNum("latitude")} />, sp)}
				{bindField(e, "props.longitude", t("overlay.weather_longitude"),
					<input type="number" step={0.0001} value={numProp(p, "longitude", 14.4378)} oninput={setNum("longitude")} />, sp)}
			</div>
			<GeoFillButton
				onFill={(lat, lon) =>
					mutate((el) => {
						el.props.latitude = lat;
						el.props.longitude = lon;
					})
				}
			/>
			{bindField(e, "props.place", t("overlay.weather_place"),
				<input type="text" value={strProp(p, "place", "")} oninput={setStr("place")} />, sp)}
			<div class="ov-grid2">
				{bindField(e, "props.format", t("overlay.weather_format"),
					<select value={strProp(p, "format", "card")}
						onchange={(ev: Event) => mutate((el) => { el.props.format = (ev.target as HTMLSelectElement).value; })}>
						<option value="card">card</option>
						<option value="pill">pill</option>
					</select>, sp)}
				{bindField(e, "props.refreshSec", t("overlay.weather_refresh"),
					<input type="number" min={60} max={3600} value={numProp(p, "refreshSec", 900)} oninput={setNum("refreshSec")} />, sp)}
			</div>
			<div class="ov-grid3">
				{bindField(e, "props.showTemp", t("overlay.weather_show_temp"),
					<input type="checkbox" checked={p.showTemp === true} onchange={setBool("showTemp")} />, sp)}
				{bindField(e, "props.showWind", t("overlay.weather_show_wind"),
					<input type="checkbox" checked={p.showWind === true} onchange={setBool("showWind")} />, sp)}
				{bindField(e, "props.showHumidity", t("overlay.weather_show_humidity"),
					<input type="checkbox" checked={p.showHumidity === true} onchange={setBool("showHumidity")} />, sp)}
			</div>
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.background", t("overlay.weather_background"),
					<input type="color" value={strProp(p, "background", "#1f2937")} oninput={setStr("background")} />, sp)}
				{bindField(e, "props.accent", t("overlay.weather_accent"),
					<input type="color" value={strProp(p, "accent", "#38bdf8")} oninput={setStr("accent")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 24)} oninput={setNum("fontSize")} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const lat = numProp(e.props, "latitude", 50);
	const lon = numProp(e.props, "longitude", 14);
	if (lat < -90 || lat > 90) problems.push("latitude out of range (-90–90)");
	if (lon < -180 || lon > 180) problems.push("longitude out of range (-180–180)");
	return problems;
}

export const weatherElement: OverlayElementDef = {
	type: "weather",
	labelKey: "overlay.add_weather",
	icon: () => <Icon name="weather" class="role-icon" />,
	order: 90,
	defaultProps: { ...DEFAULT_WEATHER_PROPS },
	propKeys: [
		"latitude",
		"longitude",
		"place",
		"format",
		"refreshSec",
		"showTemp",
		"showWind",
		"showHumidity",
		"color",
		"background",
		"accent",
		"fontSize",
	],
	defaultSize: { width: 220, height: 120 },
	draw,
	editForm,
	validate,
	handles: "box",
};
