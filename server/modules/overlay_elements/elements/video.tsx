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

/** Defensive read of a boolean prop (the contract has no `boolProp`). */
const boolProp = (p: Record<string, unknown>, key: string, fb: boolean) =>
	typeof p[key] === "boolean" ? (p[key] as boolean) : fb;

/** Clamp a volume to the 0–1 range the `<video>` element accepts. */
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	const assetId = strProp(element.props, "assetId", "");
	const url = assetId ? ctx.assetUrls.get(assetId) : undefined;
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
	assets,
	upload,
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
			{bindField(
				e,
				"props.assetId",
				t("overlay.video_asset"),
				<select
					value={String(e.props.assetId ?? "")}
					onchange={(ev: Event) =>
						mutate((el) => {
							el.props.assetId = (ev.target as HTMLSelectElement).value;
						})
					}
				>
					<option value="">—</option>
					{assets
						.filter((a) => a.mime.startsWith("video/"))
						.map((a) => (
							<option key={a.id} value={a.id}>
								{a.filename}
							</option>
						))}
				</select>,
				{ mutate, variables },
			)}
			<span class="ov-field">
				<span class="ov-upload ov-upload-btn">
					<input
						type="file"
						accept="video/*"
						onchange={(ev: Event) => {
							const input = ev.target as HTMLInputElement;
							const f = input.files?.[0];
							input.value = "";
							if (!f) return;
							void upload(f).then((id) => {
								if (id) mutate((el) => (el.props.assetId = id));
							});
						}}
					/>
					{t("overlay.upload_video")}
				</span>
			</span>
			{bindField(
				e,
				"props.volume",
				t("overlay.video_volume"),
				<input
					type="number"
					min={0}
					max={1}
					step={0.05}
					value={Number(e.props.volume ?? d.volume)}
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
	if (e.props.assetId === undefined)
		problems.push("video has no asset selected");
	// note: asset existence is enforced at the scene level by normalizeProject
	return problems;
}

export const videoElement: OverlayElementDef = {
	type: "video",
	labelKey: "overlay.add_video",
	icon: () => <Icon name="video" class="role-icon" />,
	order: 65,
	defaultProps: { ...DEFAULT_VIDEO_PROPS },
	propKeys: ["assetId", "volume", "muted", "loop", "autoplay"],
	defaultSize: { width: 320, height: 180 },
	draw,
	editForm,
	validate,
	handles: "box",
};

export default videoElement;
