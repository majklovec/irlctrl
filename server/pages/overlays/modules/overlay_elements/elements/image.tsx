/** @jsx m */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { strProp } from "@ui/overlay/element";
import type { Vnode } from "mithril";
import m from "mithril";
import { libraryAssetField } from "@ui/overlay/asset_picker";

/** The image's display URL: the asset-library file the element picks
 * (resolved by the page's context into a browsable URL). */
function imageUrl(
	element: OverlayElement,
	ctx: ElementContext,
): string | undefined {
	const libraryId = strProp(element.props, "libraryAssetId", "");
	return libraryId ? ctx.assetUrls.get(libraryId) : undefined;
}

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	const url = imageUrl(element, ctx);
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
	return m("img.overlay-image", {
		src: url,
		alt: element.name,
		draggable: false,
	});
}

function editForm({ element: e, mutate }: ElementProps): Vnode {
	return <>{libraryAssetField(e, mutate, "image")}</>;
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (e.props.libraryAssetId === undefined)
		problems.push("image has no asset selected");
	return problems;
}

export const imageElement: OverlayElementDef = {
	type: "image",
	category: "media",

	labelKey: "overlay.add_image",
	icon: () => <Icon name="image" class="role-icon" />,
	order: 60,
	defaultProps: { libraryAssetId: "" },
	propKeys: ["libraryAssetId"],
	defaultSize: { width: 240, height: 160 },
	draw,
	editForm,
	validate,
	handles: "box",
};
