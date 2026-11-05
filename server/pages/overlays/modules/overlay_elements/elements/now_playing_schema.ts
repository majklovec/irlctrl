/*
 * Now playing element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * now_playing.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/* ── now playing (Last.fm) ────────────────────────────────────────────── */
export interface NowPlayingProps {
    /** The Last.fm user to tail. */
    username: string;
    /** Last.fm API key (required by the API; left blank = the card shows a
     * setup hint rather than failing silently). */
    apiKey: string;
    refreshSec: number;
    showArtist: boolean;
    showAlbum: boolean;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_NOWPLAYING_PROPS: Required<NowPlayingProps> = {
    username: "",
    apiKey: "",
    refreshSec: 30,
    showArtist: true,
    showAlbum: false,
    color: "#ffffff",
    background: "#1f2937",
    accent: "#a78bfa",
    radius: 12,
    fontSize: 20,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const nowPlayingSchema: OverlayElementSchema = {
    type: "now_playing",
    defaultProps: DEFAULT_NOWPLAYING_PROPS,
    normalizeProps(_p, read) {
        const d = DEFAULT_NOWPLAYING_PROPS;
        return {
            username: read.str("username", "", 100),
            apiKey: read.str("apiKey", "", 100),
            refreshSec: read.num("refreshSec", d.refreshSec, 10, 3600),
            showArtist: read.bool("showArtist"),
            showAlbum: read.bool("showAlbum"),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
