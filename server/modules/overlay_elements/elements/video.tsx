/** @jsx m */

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
import { DEFAULT_VIDEO_PROPS } from "../overlay_schema";
import { libraryAssetField } from "./asset_picker";

/** Defensive read of a boolean prop (the contract has no `boolProp`). */
const boolProp = (p: Record<string, unknown>, key: string, fb: boolean) =>
	typeof p[key] === "boolean" ? (p[key] as boolean) : fb;

/** Clamp a volume to the 0–1 range the `<video>` element accepts. */
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The video's display URL: the asset-library file the element picks
 * (resolved by the page's context into a browsable URL). */
function videoUrl(
	element: OverlayElement,
	ctx: ElementContext,
): string | undefined {
	const libraryId = strProp(element.props, "libraryAssetId", "");
	return libraryId ? ctx.assetUrls.get(libraryId) : undefined;
}

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	const url = videoUrl(element, ctx);
	if (!url)
		return m(
			".overlay-shape",
			{
				style: {
					border: "1px dashed rgba(255,255,255,0.4)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					color: "rgba(255,255,255,0.5)",
					fontSize: "14px",
				},
			},
			t("overlay.missing_video"),
		);
	return m("video.overlay-video", {
		src: url,
		playsInline: true,
		preload: "metadata",
		oncreate: (vnode) => {
			const video = (vnode as unknown as { dom?: Element })
				.dom as HTMLVideoElement;
			video.muted = boolProp(element.props, "muted", true);
			video.loop = boolProp(element.props, "loop", true);
			video.volume = clamp01(numProp(element.props, "volume", 1));
			if (boolProp(element.props, "autoplay", true))
				void video.play().catch(() => {});
		},
	});
}

function editForm({
	element: e,
	mutate,
	variables,
}: ElementProps): Vnode {
	const d = DEFAULT_VIDEO_PROPS;
	const sp = { mutate, variables };
	const setBool = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).checked;
		});
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	return (
		<>
			{libraryAssetField(e, mutate, "video")}
			{bindField(
				e,
				"props.volume",
				t("overlay.video_volume"),
				<input
					type="number"
					min={0}
					max={1}
					step={0.05}
					value={numProp(e.props, "volume", d.volume)}
					oninput={setNum("volume")}
				/>,
				sp,
			)}
			{bindField(
				e,
				"props.muted",
				t("overlay.video_muted"),
				<input
					type="checkbox"
					checked={boolProp(e.props, "muted", d.muted)}
					onchange={setBool("muted")}
				/>,
				sp,
			)}
			{bindField(
				e,
				"props.loop",
				t("overlay.video_loop"),
				<input
					type="checkbox"
					checked={boolProp(e.props, "loop", d.loop)}
					onchange={setBool("loop")}
				/>,
				sp,
			)}
			{bindField(
				e,
				"props.autoplay",
				t("overlay.video_autoplay"),
				<input
					type="checkbox"
					checked={boolProp(e.props, "autoplay", d.autoplay)}
					onchange={setBool("autoplay")}
				/>,
				sp,
			)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (e.props.libraryAssetId === undefined)
		problems.push("video has no asset selected");
	return problems;
}

export const videoElement: OverlayElementDef = {
	type: "video",
	labelKey: "overlay.add_video",
	icon: () => <Icon name="video" class="role-icon" />,
	order: 65,
	defaultProps: { ...DEFAULT_VIDEO_PROPS },
	propKeys: ["libraryAssetId", "volume", "muted", "loop", "autoplay"],
	defaultSize: { width: 320, height: 180 },
	draw,
	editForm,
	validate,
	handles: "box",
};

export default videoElement;
