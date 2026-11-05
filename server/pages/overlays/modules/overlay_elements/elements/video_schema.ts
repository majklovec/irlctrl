/*
 * Video element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * video.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

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
