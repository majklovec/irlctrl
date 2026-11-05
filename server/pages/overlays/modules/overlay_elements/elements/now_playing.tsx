/** @jsx m */
/*
 * Now-Playing widget — a live "what is the streamer listening to" card fed by
 * the Last.fm public API. The element fetches its own `user.getRecentTracks`
 * in the browser (editor and OBS runtime alike) on an interval; Last.fm
 * requires an API key (a free, personal one), which the user pastes into the
 * element — it is stored in the element's props, never a global config.
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
import { DEFAULT_NOWPLAYING_PROPS } from "../overlay_schema";

const LF_URL = "https://ws.audioscrobbler.com/2.0/";

interface TrackData {
	artist: string;
	track: string;
	album: string;
}

interface NpState {
	data: TrackData | undefined;
	error: string;
	loading: boolean;
	fetching: boolean;
	timer: ReturnType<typeof setInterval>;
	/** The current refresh period (ms); restarted when the prop changes. */
	every: number;
}

interface NpAttrs {
	username: string;
	apiKey: string;
	props: Record<string, unknown>;
}

/** Fetch + render the now-playing track; owns its refresh interval. */
const NowPlayingFetch: m.Component<NpAttrs, NpState> = {
	oncreate(vnode) {
		vnode.state.data = undefined;
		vnode.state.error = "";
		vnode.state.loading = true;
		vnode.state.fetching = false;
		vnode.state.every = numProp(vnode.attrs.props, "refreshSec", 30) * 1000;
		vnode.state.timer = setInterval(
			() => void refresh(vnode),
			vnode.state.every,
		);
		void refresh(vnode);
	},
	onupdate(vnode) {
		const every = numProp(vnode.attrs.props, "refreshSec", 30) * 1000;
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
		return render(vnode.attrs, vnode.state);
	},
};

interface LastfmTrack {
	name?: string;
	artist?: { ["#text"]?: string };
	album?: { ["#text"]?: string };
}

async function refresh(vnode: m.Vnode<NpAttrs, NpState>): Promise<void> {
	const s = vnode.state;
	if (s.fetching) return;
	const { username, apiKey } = vnode.attrs;
	if (!username || !apiKey) {
		s.data = undefined;
		s.error = "setup";
		s.loading = false;
		m.redraw();
		return;
	}
	s.fetching = true;
	try {
		const params = new URLSearchParams({
			method: "user.getRecentTracks",
			user: username,
			api_key: apiKey,
			format: "json",
			limit: "1",
		});
		const res = await fetch(`${LF_URL}?${params.toString()}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as {
			error?: number;
			message?: string;
			recenttracks?: { track?: Array<LastfmTrack> };
		};
		if (json.error) throw new Error(json.message ?? "Last.fm error");
		const first = json.recenttracks?.track?.[0];
		if (!first) {
			s.data = undefined;
			s.error = "none";
		} else {
			s.data = {
				artist: strOf(first.artist?.["#text"]),
				track: strOf(first.name),
				album: strOf(first.album?.["#text"]),
			};
			s.error = "";
		}
	} catch (err) {
		s.error = err instanceof Error ? err.message : "fetch failed";
	} finally {
		s.fetching = false;
		s.loading = false;
		m.redraw();
	}
}

function strOf(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function render(
	a: NpAttrs,
	st: NpState,
): Vnode {
	const p = a.props;
	const color = strProp(p, "color", "#ffffff");
	const bg = strProp(p, "background", "#1f2937");
	const accent = strProp(p, "accent", "#a78bfa");
	const radius = numProp(p, "radius", 12);
	const fontSize = numProp(p, "fontSize", 20);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
	const showArtist = p.showArtist === true;
	const showAlbum = p.showAlbum === true;

	const title = st.data?.track ?? (st.error === "setup" ? "" : "");
	const artist = st.data?.artist ?? "";
	const album = st.data?.album ?? "";

	const lines: Vnode[] = [];
	if (st.error === "setup") {
		lines.push(
			m("div", { key: "hint", style: { opacity: "0.7" } }, t("overlay.np_setup")),
		);
	} else if (st.data) {
		if (title) lines.push(m("div", { key: "t", style: { fontWeight: "700" } }, title));
		if (showArtist && artist)
			lines.push(m("div", { key: "a", style: { opacity: "0.9" } }, artist));
		if (showAlbum && album)
			lines.push(m("div", { key: "al", style: { opacity: "0.6" } }, album));
	} else if (st.loading) {
		lines.push(m("div", { key: "ld" }, "…"));
	} else if (st.error === "none") {
		lines.push(
			m("div", { key: "nf", style: { opacity: "0.7" } }, t("overlay.np_idle")),
		);
	} else if (st.error) {
		lines.push(
			m("div", { key: "err", style: { opacity: "0.7" } }, `⚠ ${st.error}`),
		);
	}

	return (
		<div
			style={{
				width: "100%",
				height: "100%",
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-start",
				justifyContent: "center",
				gap: `${Math.round(fontSize * 0.25)}px`,
				padding: `${fontSize * 0.5}px ${fontSize * 0.7}px`,
				background: bg,
				borderLeft: `3px solid ${accent}`,
				borderRadius: `${radius}px`,
				color,
				fontFamily,
				fontSize: `${fontSize}px`,
				overflow: "hidden",
			}}
		>
			<div
				style={{
					display: "flex",
					flexDirection: "row",
					alignItems: "center",
					gap: `${fontSize * 0.5}px`,
					width: "100%",
				}}
			>
				<div
					style={{
						fontSize: `${Math.round(fontSize * 1.3)}px`,
						lineHeight: 1,
						flexShrink: 0,
					}}
				>
					♪
				</div>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: `${Math.round(fontSize * 0.15)}px`,
						minWidth: 0,
					}}
				>
					{lines}
				</div>
			</div>
		</div>
	);
}

function draw(element: OverlayElement, _ctx: ElementContext): Vnode<any, any> {
	const p = element.props;
	return m(NowPlayingFetch, {
		username: strProp(p, "username", ""),
		apiKey: strProp(p, "apiKey", ""),
		props: p,
	});
}

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	const setBool = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).checked;
		});
	return (
		<>
			{bindField(e, "props.username", t("overlay.np_username"),
				<input type="text" value={strProp(p, "username", "")} oninput={setStr("username")} />, sp)}
			{bindField(e, "props.apiKey", t("overlay.np_api_key"),
				<input type="password" value={strProp(p, "apiKey", "")} oninput={setStr("apiKey")} />, sp)}
			{bindField(e, "props.refreshSec", t("overlay.np_refresh"),
				<input type="number" min={10} max={3600} value={numProp(p, "refreshSec", 30)} oninput={setNum("refreshSec")} />, sp)}
			<div class="ov-grid2">
				{bindField(e, "props.showArtist", t("overlay.np_show_artist"),
					<input type="checkbox" checked={p.showArtist === true} onchange={setBool("showArtist")} />, sp)}
				{bindField(e, "props.showAlbum", t("overlay.np_show_album"),
					<input type="checkbox" checked={p.showAlbum === true} onchange={setBool("showAlbum")} />, sp)}
			</div>
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.background", t("overlay.np_background"),
					<input type="color" value={strProp(p, "background", "#1f2937")} oninput={setStr("background")} />, sp)}
				{bindField(e, "props.accent", t("overlay.np_accent"),
					<input type="color" value={strProp(p, "accent", "#a78bfa")} oninput={setStr("accent")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 20)} oninput={setNum("fontSize")} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	// username/apiKey are optional while editing (the card shows a setup hint).
	const size = numProp(e.props, "fontSize", 20);
	if (!(size >= 1 && size <= 400)) problems.push("font size out of range (1–400)");
	return problems;
}

export const nowPlayingElement: OverlayElementDef = {
	type: "now_playing",
	labelKey: "overlay.add_now_playing",
	icon: () => <Icon name="music" class="role-icon" />,
	order: 91,
	defaultProps: { ...DEFAULT_NOWPLAYING_PROPS },
	propKeys: [
		"username",
		"apiKey",
		"refreshSec",
		"showArtist",
		"showAlbum",
		"color",
		"background",
		"accent",
		"fontSize",
	],
	defaultSize: { width: 280, height: 100 },
	draw,
	editForm,
	validate,
	handles: "box",
};
