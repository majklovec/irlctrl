import m from "mithril";

// Pomocná funkce pro parsování "rgba(r, g, b, a)" na { hex, alpha }
function parseRgba(rgbaString) {
	const defaultResult = { hex: "#000000", alpha: 1.0 };
	if (!rgbaString || typeof rgbaString !== "string") return defaultResult;

	// Regulární výraz pro zachycení čísel uvnitř rgba() nebo rgb()
	const match = rgbaString.match(
		/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/,
	);
	if (!match) return defaultResult;

	const r = parseInt(match[1], 10);
	const g = parseInt(match[2], 10);
	const b = parseInt(match[3], 10);
	const alpha = match[4] !== undefined ? parseFloat(match[4]) : 1.0;

	// Převod RGB na HEX formát #rrggbb
	const toHex = (c) => c.toString(16).padStart(2, "0");
	const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;

	return { hex, alpha };
}

const RgbaInput = {
	view(vnode) {
		// Získání aktuální hodnoty z atributů rodiče (fallback na průhlednou černou)
		const currentValue = vnode.attrs.value || "rgba(0, 0, 0, 1)";

		// Rozklad rgba řetězce na hodnoty pro interní inputs
		const { hex, alpha } = parseRgba(currentValue);

		// Pomocná funkce, která sestaví nové RGBA a vyvolá oninput
		const handleInput = (newHex, newAlpha) => {
			if (!vnode.attrs.oninput) return;

			const r = parseInt(newHex.substring(1, 3), 16);
			const g = parseInt(newHex.substring(3, 5), 16);
			const b = parseInt(newHex.substring(5, 7), 16);
			const newValue = `rgba(${r}, ${g}, ${b}, ${newAlpha})`;

			// Simulace standardní HTML event struktury pro perfektní kompatibilitu
			vnode.attrs.oninput({
				target: {
					name: vnode.attrs.name,
					value: newValue,
				},
			});
		};

		return m(
			".rgba-input-container",
			{ style: { display: "inline-flex", alignItems: "center", gap: "8px" } },
			[
				// Slepý input picker pro barvu
				m("input[type=color]", {
					value: hex,
					style: { cursor: "pointer" },
					oninput: (e) => handleInput(e.target.value, alpha),
				}),

				// Posuvník pro Alfu
				m("input[type=range]", {
					min: 0,
					max: 1,
					step: 0.01,
					value: alpha,
					style: { width: "80px" },
					oninput: (e) => handleInput(hex, parseFloat(e.target.value)),
				}),

				// Volitelné textové zobrazení (přesně jako u běžného inputu)
				vnode.attrs.showText !== false &&
					m(
						"span",
						{ style: { fontSize: "12px", fontFamily: "monospace" } },
						`${Math.round(alpha * 100)}%`,
					),
			],
		);
	},
};

export default RgbaInput;
