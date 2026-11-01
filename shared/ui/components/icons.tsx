/* Inline SVG icons: one shape registry, one renderer. Every icon is a 24×24 outline
 * stroked with the current text colour; size, stroke and colour come from the
 * `role-icon` CSS class (per-role variants add a colour). Mithril sets the SVG
 * namespace automatically, so plain tag names render as SVG children. */

import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";

/** Single source of every icon in the app: raw 24×24 SVG contents, stroked with
 * the current text colour. Role pictograms are not here: the modules that
 * provide the roles contribute them (`roleIcons` on their frontend
 * registration, drawn with `OutlineIcon`) and components/role_tag.tsx
 * resolves them through the module registry. */
export const SHAPES = {
	info: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 16v-5M12 8h.01" />
		</>
	),
	warn: (
		<>
			<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
			<path d="M12 9v4M12 17h.01" />
		</>
	),
	error: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="m15 9-6 6M9 9l6 6" />
		</>
	),
	view: (
		<>
			<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	"view-off": (
		<>
			<path d="M9.9 5.1A11.6 11.6 0 0 1 12 5c7 0 11 7 11 7a17.4 17.4 0 0 1-3.3 4.1M6 6.6A16.5 16.5 0 0 0 2 12s4 7 10 7c1.9 0 3.6-.5 5-1.4" />
			<path d="m4 4 16 16" />
		</>
	),
	lock: (
		<>
			<rect x="5" y="11" width="14" height="9" rx="2" />
			<path d="M8 11V7a4 4 0 0 1 8 0v4" />
		</>
	),
	edit: <path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5" />,
	sync: (
		<>
			<path d="M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2" />
			<path d="M18.5 2.5v3.7h-3.7M5.5 21.5v-3.7h3.7" />
		</>
	),
	delete: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />,
	fullscreen: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" />,
	"exit-fullscreen": <path d="M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3" />,
	gear: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
		</>
	),
	dashboard: (
		<>
			<rect x="3" y="3" width="8" height="8" rx="1.5" />
			<rect x="13" y="3" width="8" height="8" rx="1.5" />
			<rect x="3" y="13" width="8" height="8" rx="1.5" />
			<rect x="13" y="13" width="8" height="8" rx="1.5" />
		</>
	),
	chevron: <path d="m9 6 6 6-6 6" />,
	plus: <path d="M12 5v14M5 12h14" />,
	copy: (
		<>
			<rect x="9" y="9" width="12" height="12" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</>
	),
	link: (
		<>
			<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
			<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
		</>
	),
	close: <path d="M18 6 6 18M6 6l12 12" />,
	undo: (
		<>
			<path d="M9 14 4 9l5-5" />
			<path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
		</>
	),
	redo: (
		<>
			<path d="m15 14 5-5-5-5" />
			<path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
		</>
	),
	text: (
		<>
			<path d="M5 7V4h14v3" />
			<path d="M12 4v16M8 20h8" />
		</>
	),
	rectangle: <rect x="3" y="5" width="18" height="14" rx="1.5" />,
	ellipse: <ellipse cx="12" cy="12" rx="9" ry="6.5" />,
	line: <path d="M5 19 19 5" />,
	progress: (
		<>
			<rect x="3" y="8" width="18" height="8" rx="4" />
			<path d="M10 8v8" />
		</>
	),
	image: (
		<>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<circle cx="8.5" cy="9.5" r="1.5" />
			<path d="m21 15-4.5-4.5L9 18" />
		</>
	),
	chat: (
		<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
	),
	bell: (
		<>
			<path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
			<path d="M10 18a2 2 0 0 0 4 0" />
		</>
	),
	iframe: (
		<>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M3 9h18" />
		</>
	),
	"zoom-in": (
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="M11 8v6M8 11h6" />
			<path d="m20.5 20.5-4.2-4.2" />
		</>
	),
	"zoom-out": (
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="M8 11h6" />
			<path d="m20.5 20.5-4.2-4.2" />
		</>
	),
} as const;

export type IconName = keyof typeof SHAPES;

export const isIconName = (name: string): name is IconName =>
	Object.hasOwn(SHAPES, name);

/** Log severity; the names match the icon entries (and the shared `LogLevel`). */
export type Level = "info" | "warn" | "error";

/**
 * An icon from the shape registry. The `role-icon` CSS class supplies size, stroke
 * and colour; any additional attributes passed here land on the SVG element.
 */
export const Icon = {
	view: ({ attrs: { name, ...rest } }) => (
		<svg viewBox="0 0 24 24" aria-hidden="true" {...rest}>
			{SHAPES[name]}
		</svg>
	),
} as MithrilJSXComponent<{ name: IconName } & m.Attributes>;

/** A 24×24 outline icon from arbitrary SVG children — what a module uses to
 * draw its own pictograms (role icons, overlay element icons) in the same
 * style as the built-in set. */
export const OutlineIcon = {
	view: ({ attrs, children }) => (
		<svg viewBox="0 0 24 24" aria-hidden="true" {...attrs}>
			{children}
		</svg>
	),
} as MithrilJSXComponent<m.Attributes>;
