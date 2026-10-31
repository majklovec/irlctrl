/** @jsx m */
import m from "mithril";
import type { Vnode } from "mithril";
import { t } from "../i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "./core";
import { strProp } from "./core";

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
			t("overlay.missing_image"),
		);
	return m("img.overlay-image", { src: url, alt: element.name, draggable: false });
}

function editForm({ element: e, mutate, assets, upload }: ElementProps): Vnode {
	return (
		<>
			<label class="ov-field">
				{t("overlay.asset")}
				<select
					value={String(e.props.assetId ?? "")}
					onchange={(ev: Event) =>
						mutate((el) => {
							el.props.assetId = (ev.target as HTMLSelectElement).value;
						})
					}
				>
					<option value="">—</option>
					{assets.map((a) => (
						<option key={a.id} value={a.id}>
							{a.filename}
						</option>
					))}
				</select>
			</label>
			<span class="ov-field">
				<span class="ov-upload ov-upload-btn">
					<input
						type="file"
						accept="image/*"
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
					{t("overlay.upload")}
				</span>
			</span>
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (e.props.assetId === undefined)
		problems.push("image has no asset selected");
	// note: asset existence is enforced at the scene level by normalizeProject
	return problems;
}

export const imageElement: OverlayElementDef = {
	type: "image",
	defaultProps: { assetId: "" },
	defaultSize: { width: 240, height: 160 },
	draw,
	editForm,
	validate,
	handles: "box",
};
