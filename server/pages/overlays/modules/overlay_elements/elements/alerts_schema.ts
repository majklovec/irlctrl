/*
 * Alert element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * alerts.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/** Alert element: fires for the named event `props.event` (published by
 * `GET /overlay/<overlay id>/event/<name>`), shows media + token text for `duration` ms,
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
