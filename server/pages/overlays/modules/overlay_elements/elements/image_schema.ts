/*
 * Image element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * image.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

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
