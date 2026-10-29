/* Inline SVG icons: one shape registry, one renderer. Every icon is a 24×24 outline
 * stroked with the current text colour; size, stroke and colour come from the
 * `role-icon` CSS class (per-role variants add a colour). Mithril sets the SVG
 * namespace automatically, so plain tag names render as SVG children. */
// biome-ignore lint/style/useImportType: <explanation>
import m from "mithril";
import type { Role } from "../../types";
import { t } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";

type ShapeTag = "circle" | "path" | "rect";
type Shape = readonly (readonly [ShapeTag, Record<string, string>])[];

/** Single source of every icon shape in the app. Role pictograms (a video camera
 * for the encoder, a broadcasting antenna for the relay, a transmission tower for
 * the broadcaster) live directly as their `Role`-named entries. */
export const SHAPES = {
	encoder: [
		["rect", { x: "2", y: "6", width: "14", height: "12", rx: "2" }],
		["path", { d: "M16 10.5 22 7v10l-6-3.5z" }],
	],
	relay: [
		["circle", { cx: "12", cy: "9", r: "2" }],
		["path", { d: "M12 11v11M9 22h6" }],
		["path", { d: "M8.5 5.5a5 5 0 0 0 0 7M15.5 5.5a5 5 0 0 1 0 7" }],
		["path", { d: "M5.6 2.6a9 9 0 0 0 0 12.8M18.4 2.6a9 9 0 0 1 0 12.8" }],
	],
	obs: [
		["rect", { x: "2", y: "3", width: "20", height: "14", rx: "2" }],
		["path", { d: "m9 7 5 3.5L9 14z" }],
		["path", { d: "M8 21h8M12 17v4" }],
	],
	broadcaster: [
		["path", { d: "M12 3v18" }],
		["path", { d: "m7 21 5-16 5 16" }],
		["path", { d: "M8.25 17h7.5" }],
		["path", { d: "M5.5 3a9.5 9.5 0 0 0 0 14" }],
		["path", { d: "M18.5 3a9.5 9.5 0 0 1 0 14" }],
	],
	info: [
		["circle", { cx: "12", cy: "12", r: "10" }],
		["path", { d: "M12 16v-5M12 8h.01" }],
	],
	warn: [
		[
			"path",
			{
				d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
			},
		],
		["path", { d: "M12 9v4M12 17h.01" }],
	],
	error: [
		["circle", { cx: "12", cy: "12", r: "10" }],
		["path", { d: "m15 9-6 6M9 9l6 6" }],
	],
	view: [
		["path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" }],
		["circle", { cx: "12", cy: "12", r: "3" }],
	],
	edit: [["path", { d: "m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5" }]],
	sync: [
		["path", { d: "M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2" }],
		["path", { d: "M18.5 2.5v3.7h-3.7M5.5 21.5v-3.7h3.7" }],
	],
	delete: [
		["path", { d: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" }],
	],
	fullscreen: [["path", { d: "M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" }]],
	"exit-fullscreen": [["path", { d: "M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3" }]],
	gear: [
		["circle", { cx: "12", cy: "12", r: "3" }],
		[
			"path",
			{
				d: "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z",
			},
		],
	],
	dashboard: [
		["rect", { x: "3", y: "3", width: "8", height: "8", rx: "1.5" }],
		["rect", { x: "13", y: "3", width: "8", height: "8", rx: "1.5" }],
		["rect", { x: "3", y: "13", width: "8", height: "8", rx: "1.5" }],
		["rect", { x: "13", y: "13", width: "8", height: "8", rx: "1.5" }],
	],
	chevron: [["path", { d: "m9 6 6 6-6 6" }]],
	plus: [["path", { d: "M12 5v14M5 12h14" }]],
} as const satisfies Record<string, Shape>;

export type IconName = keyof typeof SHAPES;

/** Log severity; the names match the icon entries (and the shared `LogLevel`). */
export type Level = "info" | "warn" | "error";

const shapeElement = {
	circle: (attrs: Record<string, string>) => <circle {...attrs} />,
	path: (attrs: Record<string, string>) => <path {...attrs} />,
	rect: (attrs: Record<string, string>) => <rect {...attrs} />,
};

/**
 * An icon from the shape registry. The `role-icon` CSS class supplies size, stroke
 * and colour; any additional attributes passed here land on the SVG element.
 */
export const Icon = {
	view: ({ attrs: { name, ...rest } }) => (
		<svg viewBox="0 0 24 24" aria-hidden="true" {...rest}>
			{SHAPES[name].map(([tag, partAttrs]) => shapeElement[tag](partAttrs))}
		</svg>
	),
} as MithrilJSXComponent<{ name: IconName } & m.Attributes>;

const roleIcon = (role: Exclude<Role, "combined">): m.Vnode =>
	<Icon name={role} class={`role-icon role-icon-${role}`} />;

/** Role icon(s) with the translated role as tooltip; combined devices get both icons. */
export const RoleTag = {
	view: ({ attrs: { role } }) => (
		<span class="role" title={t(`role.${role}`)}>
			{role === "combined"
				? [roleIcon("encoder"), roleIcon("relay")]
				: roleIcon(role)}
		</span>
	),
} as MithrilJSXComponent<{ role: Role }>;
