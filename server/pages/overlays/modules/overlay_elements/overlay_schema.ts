/*
 * Schemas of the built-in overlay elements (environment-free: shared by the
 * control server's scene validator and the browser editor). The rendering
 * and inspector halves live next to each one in elements/*.tsx.
 */
import type { OverlayElementSchema } from "../../../shared/contracts/overlay_element";

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
];
