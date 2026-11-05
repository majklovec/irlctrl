/*
 * Schemas of the built-in overlay elements (environment-free: shared by the
 * control server's scene validator and the browser editor). The rendering
 * and inspector halves live next to each one in elements/*.tsx.
 */
import type { OverlayElementSchema } from "../../../../core/overlay_element";

export interface TextProps {
    text: string;
    fontSize: number;
    fontFamily: string;
    color: string;
    weight: number;
    lineHeight: number;
    align: "left" | "center" | "right";
}

export const DEFAULT_TEXT_PROPS: Required<TextProps> = {
    text: "Text",
    fontSize: 48,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    color: "#ffffff",
    weight: 400,
    lineHeight: 1.2,
    align: "left",
};

export const textSchema: OverlayElementSchema = {
    type: "text",
    defaultProps: DEFAULT_TEXT_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_TEXT_PROPS;
        return {
            text: read.str("text", d.text, 10000),
            fontSize: read.num("fontSize", d.fontSize, 1, 2000),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
            color: read.hex("color", d.color),
            weight: read.num("weight", d.weight, 100, 900),
            lineHeight: read.num("lineHeight", d.lineHeight, 0.1, 10),
            align: read.oneOf("align", ["left", "center", "right"], d.align),
        };
    },
};

/** Rectangle / ellipse / line are distinct element types; each carries its
 * own (slimmer) prop set instead of one `shape` discriminator. */
export interface RectangleProps {
    fill: string;
    stroke: string;
    strokeWidth: number;
    /** corner radius in px (0 = square corners) */
    radius: number;
}

export const DEFAULT_RECTANGLE_PROPS: Required<RectangleProps> = {
    fill: "#3b82f6",
    stroke: "#000000",
    strokeWidth: 0,
    radius: 0,
};

export const rectangleSchema: OverlayElementSchema = {
    type: "rectangle",
    defaultProps: DEFAULT_RECTANGLE_PROPS,
    normalizeProps(_props, read) {
        const d = DEFAULT_RECTANGLE_PROPS;
        return {
            fill: read.hex("fill", d.fill),
            stroke: read.hex("stroke", d.stroke),
            strokeWidth: read.num("strokeWidth", d.strokeWidth, 0, 500),
            radius: read.num("radius", d.radius, 0, 10000),
        };
    },
};

export interface EllipseProps {
    fill: string;
    stroke: string;
    strokeWidth: number;
}

export const DEFAULT_ELLIPSE_PROPS: Required<EllipseProps> = {
    fill: "#3b82f6",
    stroke: "#000000",
    strokeWidth: 0,
};

export const ellipseSchema: OverlayElementSchema = {
    type: "ellipse",
    defaultProps: DEFAULT_ELLIPSE_PROPS,
    normalizeProps(_props, read) {
        const d = DEFAULT_ELLIPSE_PROPS;
        return {
            fill: read.hex("fill", d.fill),
            stroke: read.hex("stroke", d.stroke),
            strokeWidth: read.num("strokeWidth", d.strokeWidth, 0, 500),
        };
    },
};

export interface ProgressProps {
    /** progress percentage, 0–100 */
    value: number;
    /** color of the filled portion */
    fill: string;
    /** color of the empty track behind the fill */
    background: string;
    /** corner radius in px (0 = square corners) */
    radius: number;
}

export const DEFAULT_PROGRESS_PROPS: Required<ProgressProps> = {
    value: 25,
    fill: "#22c55e",
    background: "#e5e7eb",
    radius: 6,
};

export const progressSchema: OverlayElementSchema = {
    type: "progress",
    defaultProps: DEFAULT_PROGRESS_PROPS,
    normalizeProps(_props, read) {
        const d = DEFAULT_PROGRESS_PROPS;
        return {
            value: read.num("value", d.value, 0, 100),
            fill: read.hex("fill", d.fill),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 10000),
        };
    },
};

export interface LineProps {
    /** the line's color */
    stroke: string;
    /** the line's thickness in px */
    strokeWidth: number;
    /**
     * Which box diagonal the line runs along. The box is stored in
     * min/abs form (negative deltas are impossible in CSS), so this flag
     * disambiguates: false = top-left → bottom-right, true = top-right →
     * bottom-left.
     */
    flip: boolean;
}

export const DEFAULT_LINE_PROPS: Required<LineProps> = {
    stroke: "#3b82f6",
    strokeWidth: 4,
    flip: false,
};

export const lineSchema: OverlayElementSchema = {
    type: "line",
    defaultProps: DEFAULT_LINE_PROPS,
    normalizeProps(_props, read) {
        const d = DEFAULT_LINE_PROPS;
        return {
            stroke: read.hex("stroke", d.stroke),
            strokeWidth: read.num("strokeWidth", d.strokeWidth, 1, 500),
            flip: read.bool("flip"),
        };
    },
};

export interface ImageProps {
    /** id of a file in the user's asset library; `""` (or a missing file)
     * renders an empty box */
    libraryAssetId: string;
}

export const DEFAULT_IMAGE_PROPS: Required<ImageProps> = {
    libraryAssetId: "",
};

export const imageSchema: OverlayElementSchema = {
    type: "image",
    defaultProps: DEFAULT_IMAGE_PROPS,
    serverAssetProps: ["libraryAssetId"],
    normalizeProps(_props, read) {
        return {
            libraryAssetId: read.str("libraryAssetId", "", 200),
        };
    },
};

export interface VideoProps {
    /** id of a file in the user's asset library (video/*); `""` (or a missing
     * file) renders an empty box */
    libraryAssetId: string;
    /** 0–1, the video's audio track (no effect while muted) */
    volume: number;
    /** muted videos are the only ones browsers allow to autoplay — the safe default */
    muted: boolean;
    /** restart from the beginning when the video ends */
    loop: boolean;
    /** start playing on page load (a browser may defer it while un-muted) */
    autoplay: boolean;
}

export const DEFAULT_VIDEO_PROPS: Required<VideoProps> = {
    libraryAssetId: "",
    volume: 1,
    muted: true,
    loop: true,
    autoplay: true,
};

export const videoSchema: OverlayElementSchema = {
    type: "video",
    defaultProps: DEFAULT_VIDEO_PROPS,
    serverAssetProps: ["libraryAssetId"],
    normalizeProps(props, read) {
        const d = DEFAULT_VIDEO_PROPS;
        return {
            libraryAssetId: read.str("libraryAssetId", "", 200),
            volume: read.num("volume", d.volume, 0, 1),
            // `read.bool` can't express a default of `true` (a missing key
            // reads as `false`), so these flags keep their default unless the
            // stored value is a real boolean.
            muted:
                typeof props.muted === "boolean" ? props.muted : d.muted,
            loop: typeof props.loop === "boolean" ? props.loop : d.loop,
            autoplay:
                typeof props.autoplay === "boolean"
                    ? props.autoplay
                    : d.autoplay,
        };
    },
};

export interface IframeProps {
    /** The page to embed. Any absolute URL; `""` renders a placeholder box. */
    url: string;
}

export const DEFAULT_IFRAME_PROPS: Required<IframeProps> = { url: "" };

export const iframeSchema: OverlayElementSchema = {
    type: "iframe",
    defaultProps: DEFAULT_IFRAME_PROPS,
    // A bare string (no scheme or path checks — the browser decides what a
    // URL is worth loading); a missing value falls back to "".
    normalizeProps(_props, read) {
        return { url: read.str("url", "") };
    },
};

/** A group has no props of its own; it exists to parent other elements. */
export const groupSchema: OverlayElementSchema = {
    type: "group",
    defaultProps: {},
    container: true,
    normalizeProps: () => ({}),
};

/** Alert element: fires for the named event `props.event` (published by
 * `GET /overlay/alert/<name>`), shows media + token text for `duration` ms,
 * then fades out (TODO.md "Alert element"). Consecutive triggers on the
 * same element queue FIFO; the trigger's `<name>=<value>` pairs ride with
 * the alert and are written to the project variables when the alert
 * plays (a queued alert's values never clobber the on-air ones early). */
export const ALERT_INTRO_ANIMATIONS = [
    "none",
    "fadeIn",
    "slideDown",
    "slideUp",
    "slideLeft",
    "slideRight",
    "zoomIn",
    "bounceIn",
] as const;

export const ALERT_OUTRO_ANIMATIONS = [
    "none",
    "fadeOut",
    "zoomOut",
    "slideDown",
    "slideUp",
] as const;

export const ALERT_TEXT_ANIMATIONS = [
    "none",
    "fadeIn",
    "typewriter",
    "pop",
] as const;

export interface AlertProps {
    /** trigger event name the alert listens for */
    event: string;
    /** how long the alert stays on screen, ms */
    duration: number;
    /** stack = media above text, row = media left of text, overlay = text over media */
    layoutType: "stack" | "row" | "overlay";
    assetType: "image" | "video";
    /** main media (image/* or video/* asset) */
    mediaAssetId: string;
    /** 0–1, the video's own audio track */
    videoVolume: number;
    /** separate sting (audio/* asset) played on trigger */
    audioAssetId: string;
    /** 0–1 */
    audioVolume: number;
    /** `{token}` templates; tokens resolve by variable name, then payload key */
    titleTemplate: string;
    messageTemplate: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    fontColor: string;
    /** colour of the dynamic tokens only */
    accentColor: string;
    introAnimation: string;
    outroAnimation: string;
    textAnimation: string;
    /** variation: fires only when its condition on `amount` holds */
    isVariation: boolean;
    conditionType: "exact" | "min";
    conditionValue: number;
    ttsEnabled: boolean;
    /** speech-synthesis voice name; "" = the engine default */
    ttsVoice: string;
    /** 0–1 */
    ttsVolume: number;
    /** TTS is allowed only when the event's amount reaches this */
    ttsMinAmount: number;
}

export const DEFAULT_ALERT_PROPS: Required<AlertProps> = {
    event: "twitch.follow",
    duration: 5000,
    layoutType: "stack",
    assetType: "image",
    mediaAssetId: "",
    videoVolume: 1,
    audioAssetId: "",
    audioVolume: 1,
    titleTemplate: "Hello {name}!",
    messageTemplate: "{message}",
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: 28,
    fontWeight: 700,
    fontColor: "#ffffff",
    accentColor: "#ffd700",
    introAnimation: "slideDown",
    outroAnimation: "fadeOut",
    textAnimation: "none",
    isVariation: false,
    conditionType: "min",
    conditionValue: 0,
    ttsEnabled: false,
    ttsVoice: "",
    ttsVolume: 1,
    ttsMinAmount: 0,
};

export const alertSchema: OverlayElementSchema = {
    type: "alert",
    defaultProps: DEFAULT_ALERT_PROPS,
    serverAssetProps: ["mediaAssetId", "audioAssetId"],
    normalizeProps(_props, read) {
        const d = DEFAULT_ALERT_PROPS;
        return {
            event: read.str("event", d.event, 100),
            duration: read.num("duration", d.duration, 500, 60000),
            layoutType: read.oneOf(
                "layoutType",
                ["stack", "row", "overlay"],
                d.layoutType,
            ),
            assetType: read.oneOf("assetType", ["image", "video"], d.assetType),
            mediaAssetId: read.str("mediaAssetId", ""),
            videoVolume: read.num("videoVolume", d.videoVolume, 0, 1),
            audioAssetId: read.str("audioAssetId", ""),
            audioVolume: read.num("audioVolume", d.audioVolume, 0, 1),
            titleTemplate: read.str("titleTemplate", d.titleTemplate, 500),
            messageTemplate: read.str(
                "messageTemplate",
                d.messageTemplate,
                2000,
            ),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
            fontSize: read.num("fontSize", d.fontSize, 8, 400),
            fontWeight: read.num("fontWeight", d.fontWeight, 100, 900),
            fontColor: read.hex("fontColor", d.fontColor),
            accentColor: read.hex("accentColor", d.accentColor),
            introAnimation: read.oneOf(
                "introAnimation",
                ALERT_INTRO_ANIMATIONS,
                d.introAnimation,
            ),
            outroAnimation: read.oneOf(
                "outroAnimation",
                ALERT_OUTRO_ANIMATIONS,
                d.outroAnimation,
            ),
            textAnimation: read.oneOf(
                "textAnimation",
                ALERT_TEXT_ANIMATIONS,
                d.textAnimation,
            ),
            isVariation: read.bool("isVariation"),
            conditionType: read.oneOf(
                "conditionType",
                ["exact", "min"],
                d.conditionType,
            ),
            conditionValue: read.num(
                "conditionValue",
                d.conditionValue,
                0,
                1e12,
            ),
            ttsEnabled: read.bool("ttsEnabled"),
            ttsVoice: read.str("ttsVoice", "", 200),
            ttsVolume: read.num("ttsVolume", d.ttsVolume, 0, 1),
            ttsMinAmount: read.num("ttsMinAmount", d.ttsMinAmount, 0, 1e12),
        };
    },
};

/*
 * ── Senchabot-derived widgets (TODO/05-widgets.md) ────────────────────────
 *
 * Native re-implementations of the selected Senchabot widgets. Each is one
 * element type with its own prop set + edit form. The list props are
 * normalized here (the scalar `read` helpers can't touch object arrays),
 * mirroring how `alertSchema` / the chat schema handle their structured
 * props. Shared pure normalizers live just above the schemas.
 */

/** Defensive scalar coercions for the list-row normalizers below. */
const cleanStr = (v: unknown, max: number): string =>
    typeof v === "string" ? v.slice(0, max) : "";
const cleanNum = (
    v: unknown,
    def: number,
    min = 0,
    max = 1e12,
): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
const cleanBool = (v: unknown): boolean => v === true;

/** A platform channel a chat-driven widget displays (mirrors the chat
 * element's `channels`). Kept here so the schema stays free of the browser
 * lib (which imports mithril). */
export interface ChannelRow {
    platform: "youtube" | "twitch" | "tiktok" | "kick";
    channel: string;
}
const CHAT_PLATFORMS = ["youtube", "twitch", "tiktok", "kick"] as const;
function normalizeChannelRows(raw: unknown, max = 8): ChannelRow[] {
    if (!Array.isArray(raw)) return [];
    const out: ChannelRow[] = [];
    for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const platform = (item as { platform?: unknown }).platform;
        if (
            typeof platform !== "string" ||
            !(CHAT_PLATFORMS as readonly string[]).includes(platform)
        )
            continue;
        const channel = cleanStr(
            (item as { channel?: unknown }).channel as string | undefined,
            100,
        )
            .trim()
            .toLowerCase();
        out.push({ platform: platform as ChannelRow["platform"], channel });
        if (out.length >= max) break;
    }
    return out;
}
/** A generic `{label, ...}` text row. */
function textRows(
    raw: unknown,
    max: number,
    second?: { key: string; kind: "str" | "num" | "bool" },
): Array<Record<string, unknown>> {
    if (!Array.isArray(raw)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const label = cleanStr(rec.label, 120);
        const row: Record<string, unknown> = { label };
        if (second) {
            if (second.kind === "num") row[second.key] = cleanNum(rec[second.key], 0);
            else if (second.kind === "bool") row[second.key] = cleanBool(rec[second.key]);
            else row[second.key] = cleanStr(rec[second.key], 120);
        }
        out.push(row);
        if (out.length >= max) break;
    }
    return out;
}

/* ── weather ──────────────────────────────────────────────────────────── */
export interface WeatherProps {
    latitude: number;
    longitude: number;
    /** Optional place name shown under the reading. */
    place: string;
    format: "card" | "pill";
    /** Refresh period in seconds. */
    refreshSec: number;
    showTemp: boolean;
    showWind: boolean;
    showHumidity: boolean;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_WEATHER_PROPS: Required<WeatherProps> = {
    latitude: 50.0755,
    longitude: 14.4378,
    place: "",
    format: "card",
    refreshSec: 900,
    showTemp: true,
    showWind: true,
    showHumidity: false,
    color: "#ffffff",
    background: "#1f2937",
    accent: "#38bdf8",
    radius: 12,
    fontSize: 24,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const weatherSchema: OverlayElementSchema = {
    type: "weather",
    defaultProps: DEFAULT_WEATHER_PROPS,
    normalizeProps(_p, read) {
        const d = DEFAULT_WEATHER_PROPS;
        return {
            latitude: read.num("latitude", d.latitude, -90, 90),
            longitude: read.num("longitude", d.longitude, -180, 180),
            place: read.str("place", "", 120),
            format: read.oneOf("format", ["card", "pill"], d.format),
            refreshSec: read.num("refreshSec", d.refreshSec, 60, 3600),
            // `read.bool` can't express a `true` default (a missing key reads
            // `false`), so keep the stored value unless it is a real boolean.
            showTemp:
                typeof _p.showTemp === "boolean" ? _p.showTemp : d.showTemp,
            showWind: read.bool("showWind"),
            showHumidity: read.bool("showHumidity"),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

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

/* ── countdown ────────────────────────────────────────────────────────── */
export interface CountdownProps {
    /** `duration` = count down a fixed time; `clock` = count to a clock time. */
    mode: "duration" | "clock";
    /** Remaining/total time in seconds (duration mode). */
    duration: number;
    /** 24h `HH:MM` target (clock mode). */
    clockTarget: string;
    label: string;
    labelDone: string;
    /** Restart automatically when it reaches zero. */
    loop: boolean;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_COUNTDOWN_PROPS: Required<CountdownProps> = {
    mode: "duration",
    duration: 60,
    clockTarget: "20:00",
    label: "Starting in",
    labelDone: "Start now!",
    loop: false,
    color: "#ffffff",
    background: "#111827",
    accent: "#f59e0b",
    radius: 12,
    fontSize: 40,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const countdownSchema: OverlayElementSchema = {
    type: "countdown",
    defaultProps: DEFAULT_COUNTDOWN_PROPS,
    normalizeProps(_p, read) {
        const d = DEFAULT_COUNTDOWN_PROPS;
        return {
            mode: read.oneOf("mode", ["duration", "clock"], d.mode),
            duration: read.num("duration", d.duration, 1, 100000),
            clockTarget: read.str("clockTarget", d.clockTarget, 8),
            label: read.str("label", d.label, 120),
            labelDone: read.str("labelDone", d.labelDone, 120),
            loop: read.bool("loop"),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── lower third ──────────────────────────────────────────────────────── */
export interface LowerThirdProps {
    /** The name/topic lines; rotate cycles through them. */
    entries: Array<{ name: string; topic: string }>;
    rotate: boolean;
    /** Per-entry time in ms (rotation). */
    interval: number;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_LOWER_THIRD_PROPS: Required<LowerThirdProps> = {
    entries: [{ name: "Your Name", topic: "Your topic here" }],
    rotate: false,
    interval: 6000,
    color: "#ffffff",
    background: "#111827",
    accent: "#38bdf8",
    radius: 8,
    fontSize: 30,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const lowerThirdSchema: OverlayElementSchema = {
    type: "lower_third",
    defaultProps: DEFAULT_LOWER_THIRD_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_LOWER_THIRD_PROPS;
        const raw = Array.isArray(props.entries) ? props.entries : [];
        return {
            entries: raw.slice(0, 16).map((item) => {
                const rec =
                    typeof item === "object" && item !== null
                        ? (item as Record<string, unknown>)
                        : {};
                return {
                    name: cleanStr(rec.name, 120),
                    topic: cleanStr(rec.topic, 200),
                };
            }),
            rotate: read.bool("rotate"),
            interval: read.num("interval", d.interval, 1000, 600000),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── frame ────────────────────────────────────────────────────────────── */
export interface FrameProps {
    border: string;
    borderWidth: number;
    borderStyle: "solid" | "dashed" | "double";
    cornerRadius: number;
    /** The corner/padding fill; "" = fully transparent centre. */
    background: string;
    /** A label pinned in a corner ("" = none). */
    label: string;
    color: string;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_FRAME_PROPS: Required<FrameProps> = {
    border: "#f59e0b",
    borderWidth: 8,
    borderStyle: "solid",
    cornerRadius: 0,
    background: "",
    label: "LIVE",
    color: "#ffffff",
    fontSize: 22,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const frameSchema: OverlayElementSchema = {
    type: "frame",
    defaultProps: DEFAULT_FRAME_PROPS,
    normalizeProps(_p, read) {
        const d = DEFAULT_FRAME_PROPS;
        return {
            border: read.hex("border", d.border),
            borderWidth: read.num("borderWidth", d.borderWidth, 0, 200),
            borderStyle: read.oneOf(
                "borderStyle",
                ["solid", "dashed", "double"],
                d.borderStyle,
            ),
            cornerRadius: read.num("cornerRadius", d.cornerRadius, 0, 1000),
            // background is "" (transparent) by design, not a stored hex —
            // normalize it as a string.
            background:
                typeof _p.background === "string" && _p.background !== ""
                    ? read.hex("background", _p.background)
                    : "",
            label: read.str("label", d.label, 24),
            color: read.hex("color", d.color),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── socials ──────────────────────────────────────────────────────────── */
export interface SocialsProps {
    entries: Array<{ label: string; handle: string }>;
    /** Cycle one entry at a time (slide). */
    slide: boolean;
    /** Per-entry time in ms (slide mode). */
    interval: number;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_SOCIALS_PROPS: Required<SocialsProps> = {
    entries: [{ label: "Twitch", handle: "twitch.tv/you" }],
    slide: false,
    interval: 4000,
    color: "#ffffff",
    background: "#111827",
    accent: "#38bdf8",
    radius: 10,
    fontSize: 22,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const socialsSchema: OverlayElementSchema = {
    type: "socials",
    defaultProps: DEFAULT_SOCIALS_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_SOCIALS_PROPS;
        return {
            entries: textRows(props.entries, 12, { key: "handle", kind: "str" }).map(
                (r) => ({ label: String(r.label), handle: String(r.handle) }),
            ),
            slide: read.bool("slide"),
            interval: read.num("interval", d.interval, 1000, 600000),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── credits ──────────────────────────────────────────────────────────── */
export interface CreditsProps {
    title: string;
    entries: Array<{ name: string; role: string }>;
    /** Scroll rate: lines per second (higher = faster). */
    speed: number;
    /** Restart the scroll after it completes. */
    loop: boolean;
    color: string;
    accent: string;
    background: string;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_CREDITS_PROPS: Required<CreditsProps> = {
    title: "With special thanks to",
    entries: [{ name: "Supporter", role: "Subscriber" }],
    speed: 1,
    loop: true,
    color: "#ffffff",
    accent: "#ffd700",
    background: "#000000",
    fontSize: 24,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const creditsSchema: OverlayElementSchema = {
    type: "credits",
    defaultProps: DEFAULT_CREDITS_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_CREDITS_PROPS;
        return {
            title: read.str("title", d.title, 200),
            entries: textRows(props.entries, 64, {
                key: "role",
                kind: "str",
            }).map((r) => ({ name: String(r.label), role: String(r.role) })),
            speed: read.num("speed", d.speed, 0.1, 20),
            loop: read.bool("loop"),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── tasks ────────────────────────────────────────────────────────────── */
export interface TasksProps {
    title: string;
    entries: Array<{ label: string; done: boolean }>;
    color: string;
    accent: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_TASKS_PROPS: Required<TasksProps> = {
    title: "Today's goals",
    entries: [{ label: "Reach 1000 viewers", done: false }],
    color: "#ffffff",
    accent: "#22c55e",
    background: "#111827",
    radius: 10,
    fontSize: 22,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const tasksSchema: OverlayElementSchema = {
    type: "tasks",
    defaultProps: DEFAULT_TASKS_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_TASKS_PROPS;
        return {
            title: read.str("title", d.title, 120),
            entries: textRows(props.entries, 24, {
                key: "done",
                kind: "bool",
            }).map((r) => ({ label: String(r.label), done: r.done === true })),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── goal ─────────────────────────────────────────────────────────────── */
export interface GoalProps {
    label: string;
    /** The target value to reach. */
    target: number;
    /** Current progress; bind this to a variable to make it live. */
    value: number;
    color: string;
    fill: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
    showValue: boolean;
}
export const DEFAULT_GOAL_PROPS: Required<GoalProps> = {
    label: "Sub goal",
    target: 100,
    value: 0,
    color: "#ffffff",
    fill: "#22c55e",
    background: "#e5e7eb",
    radius: 8,
    fontSize: 20,
    fontFamily: "Inter, system-ui, sans-serif",
    showValue: true,
};
export const goalSchema: OverlayElementSchema = {
    type: "goal",
    defaultProps: DEFAULT_GOAL_PROPS,
    normalizeProps(_p, read) {
        const d = DEFAULT_GOAL_PROPS;
        return {
            label: read.str("label", d.label, 120),
            target: read.num("target", d.target, 1, 1e12),
            value: read.num("value", d.value, 0, 1e12),
            color: read.hex("color", d.color),
            fill: read.hex("fill", d.fill),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
            showValue: read.bool("showValue"),
        };
    },
};

/* ── counter ──────────────────────────────────────────────────────────── */
export interface CounterProps {
    title: string;
    /** Up to four counters; `value` is bindable per-counter by variable. */
    counters: Array<{ label: string; value: number }>;
    layout: "row" | "column";
    color: string;
    accent: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_COUNTER_PROPS: Required<CounterProps> = {
    title: "",
    counters: [
        { label: "Wins", value: 0 },
        { label: "Losses", value: 0 },
    ],
    layout: "row",
    color: "#ffffff",
    accent: "#f59e0b",
    background: "#111827",
    radius: 10,
    fontSize: 26,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const counterSchema: OverlayElementSchema = {
    type: "counter",
    defaultProps: DEFAULT_COUNTER_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_COUNTER_PROPS;
        return {
            title: read.str("title", d.title, 120),
            counters: textRows(props.counters, 4, {
                key: "value",
                kind: "num",
            }).map((r) => ({
                label: String(r.label),
                value: cleanNum(r.value, 0, -1e12, 1e12),
            })),
            layout: read.oneOf("layout", ["row", "column"], d.layout),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── spin wheel ───────────────────────────────────────────────────────── */
export interface SpinWheelProps {
    /** The trigger event that spins the wheel (the alert channel). */
    event: string;
    prizes: string[];
    /** Spin duration in ms. */
    duration: number;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_SPIN_WHEEL_PROPS: Required<SpinWheelProps> = {
    event: "spin",
    prizes: ["Prize 1", "Prize 2", "Prize 3", "Prize 4"],
    duration: 4000,
    color: "#ffffff",
    background: "#111827",
    accent: "#f59e0b",
    radius: 0,
    fontSize: 16,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const spinWheelSchema: OverlayElementSchema = {
    type: "spin_wheel",
    defaultProps: DEFAULT_SPIN_WHEEL_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_SPIN_WHEEL_PROPS;
        const raw = Array.isArray(props.prizes) ? props.prizes : [];
        return {
            event: read.str("event", d.event, 100),
            prizes: raw
                .map((v) => cleanStr(v, 60))
                .filter((v) => v !== "")
                .slice(0, 24),
            duration: read.num("duration", d.duration, 500, 60000),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 1000),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── emote wall (chat-driven) ─────────────────────────────────────────── */
export interface EmoteWallProps {
    channels: ChannelRow[];
    /** How the emotes move. */
    motion: "calm" | "normal" | "chaos" | "bounce";
    /** Max concurrent floating emotes. */
    maxEmotes: number;
    /** Float lifetime in ms. */
    lifetime: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_EMOTE_WALL_PROPS: Required<EmoteWallProps> = {
    channels: [],
    motion: "normal",
    maxEmotes: 24,
    lifetime: 8000,
    fontSize: 40,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const emoteWallSchema: OverlayElementSchema = {
    type: "emote_wall",
    defaultProps: DEFAULT_EMOTE_WALL_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_EMOTE_WALL_PROPS;
        return {
            channels: normalizeChannelRows(props.channels),
            motion: read.oneOf(
                "motion",
                ["calm", "normal", "chaos", "bounce"],
                d.motion,
            ),
            maxEmotes: read.num("maxEmotes", d.maxEmotes, 1, 200),
            lifetime: read.num("lifetime", d.lifetime, 1000, 120000),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── emote combo (chat-driven) ────────────────────────────────────────── */
export interface EmoteComboProps {
    channels: ChannelRow[];
    /** Window (seconds) in which repeats count as a combo. */
    windowSec: number;
    /** Minimum repeats before the combo shows. */
    threshold: number;
    color: string;
    accent: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_EMOTE_COMBO_PROPS: Required<EmoteComboProps> = {
    channels: [],
    windowSec: 5,
    threshold: 3,
    color: "#ffffff",
    accent: "#ffd700",
    background: "#111827",
    radius: 10,
    fontSize: 28,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const emoteComboSchema: OverlayElementSchema = {
    type: "emote_combo",
    defaultProps: DEFAULT_EMOTE_COMBO_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_EMOTE_COMBO_PROPS;
        return {
            channels: normalizeChannelRows(props.channels),
            windowSec: read.num("windowSec", d.windowSec, 1, 120),
            threshold: read.num("threshold", d.threshold, 2, 1000),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── featured (chat-driven) ───────────────────────────────────────────── */
export interface FeaturedProps {
    channels: ChannelRow[];
    /** What to feature: "message" (latest chat line) or "user" (latest sender). */
    kind: "message" | "user";
    color: string;
    accent: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_FEATURED_PROPS: Required<FeaturedProps> = {
    channels: [],
    kind: "message",
    color: "#ffffff",
    accent: "#38bdf8",
    background: "#111827",
    radius: 12,
    fontSize: 26,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const featuredSchema: OverlayElementSchema = {
    type: "featured",
    defaultProps: DEFAULT_FEATURED_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_FEATURED_PROPS;
        return {
            channels: normalizeChannelRows(props.channels),
            kind: read.oneOf("kind", ["message", "user"], d.kind),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};

/* ── chat (full live feed) ────────────────────────────────────────────── */
export interface ChatProps {
    /** The platform channels to display (a dynamic list; empty = nothing). */
    channels: ChannelRow[];
    /** Where new messages enter the feed: "top" (newest first) or "bottom". */
    order: "top" | "bottom";
    /** How moderated (removed) messages present: "strike-through" or "hide". */
    bannedMessages: "strike" | "hide";
    /** Show each message's arrival time. */
    timestamps: "off" | "on";
    /** Show the sender's badges (subscriber/moderator, …) in front of the name. */
    badges: "off" | "on";
    /** Platform icons: "auto" (only when >1 channel), forced "on", or "off". */
    platformIcons: "auto" | "on" | "off";
    /** Feed text size in px. */
    fontSize: number;
    /** Feed text font stack. */
    fontFamily: string;
    /** Feed text colour (`#rrggbb`). */
    color: string;
    /** Feed text weight. */
    fontWeight: number;
    /** Feed text line-height (unitless). */
    lineHeight: number;
    /** Spacing between feed lines in px (0 = none). */
    messageSpacing: number;
    /** Which feed edge fades out into the background. */
    fadeDirection: "off" | "top" | "bottom";
    /** Fade-out size in px. */
    fadeSize: number;
    /** Alignment of the feed text. */
    textAlign: "left" | "center" | "right" | "justify";
}
export const DEFAULT_CHAT_PROPS: Required<ChatProps> = {
    channels: [],
    order: "top",
    bannedMessages: "strike",
    timestamps: "off",
    badges: "on",
    platformIcons: "auto",
    fontSize: 48,
    fontFamily: "Inter, system-ui, sans-serif",
    color: "#ffffff",
    fontWeight: 600,
    lineHeight: 1.2,
    messageSpacing: 0,
    fadeDirection: "off",
    // ~6rem — the size of a few feed lines.
    fadeSize: 96,
    textAlign: "left",
};
export const chatSchema: OverlayElementSchema = {
    type: "chat",
    defaultProps: DEFAULT_CHAT_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_CHAT_PROPS;
        return {
            // `channels` is an object array, so it is normalized directly from
            // the raw record (the scalar `read` helpers can't touch it).
            channels: normalizeChannelRows(props.channels),
            order: read.oneOf("order", ["top", "bottom"], d.order),
            bannedMessages: read.oneOf(
                "bannedMessages",
                ["strike", "hide"],
                d.bannedMessages,
            ),
            timestamps: read.oneOf("timestamps", ["off", "on"], d.timestamps),
            badges: read.oneOf("badges", ["off", "on"], d.badges),
            platformIcons: read.oneOf(
                "platformIcons",
                ["auto", "on", "off"],
                d.platformIcons,
            ),
            fontSize: read.num("fontSize", d.fontSize, 1, 2000),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
            color: read.hex("color", d.color),
            fontWeight: read.num("fontWeight", d.fontWeight, 100, 900),
            lineHeight: read.num("lineHeight", d.lineHeight, 0.1, 10),
            messageSpacing: read.num("messageSpacing", d.messageSpacing, 0, 100),
            fadeDirection: read.oneOf(
                "fadeDirection",
                ["off", "top", "bottom"],
                d.fadeDirection,
            ),
            fadeSize: read.num("fadeSize", d.fadeSize, 1, 500),
            textAlign: read.oneOf(
                "textAlign",
                ["left", "center", "right", "justify"],
                d.textAlign,
            ),
        };
    },
};

export default [
    textSchema,
    imageSchema,
    videoSchema,
    rectangleSchema,
    ellipseSchema,
    lineSchema,
    progressSchema,
    iframeSchema,
    groupSchema,
    alertSchema,
    weatherSchema,
    nowPlayingSchema,
    countdownSchema,
    lowerThirdSchema,
    frameSchema,
    socialsSchema,
    creditsSchema,
    tasksSchema,
    goalSchema,
    counterSchema,
    spinWheelSchema,
    emoteWallSchema,
    emoteComboSchema,
    featuredSchema,
    chatSchema,
];
