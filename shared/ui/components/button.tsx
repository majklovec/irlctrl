/** @jsx m */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";
import type { Child } from "../util";

/** <button type="button">; pass `type: "submit"` for a form's default action. */
export const Button = {
	view: ({ attrs: { label, type = "button", ...rest } }) => (
		<button type={type} {...rest}>
			{label}
		</button>
	),
} as MithrilJSXComponent<{ label: Child } & m.Attributes>;

/** <div.actions> row of buttons. */
export const Actions = {
	view: ({ children }) => <div class="actions">{children}</div>,
} as MithrilJSXComponent<{ children?: m.Children }>;

/** A square icon-only button: the icon is the label, the `label` text is
 * its tooltip and accessible name. `danger` colours it for destructive
 * actions (delete). */
export const IconButton = {
	view: ({ attrs: { icon, label, danger, class: cls, ...rest } }) => (
		<button
			type="button"
			class={["icon-link", danger ? "dash-delete" : "", cls ?? ""]
				.filter(Boolean)
				.join(" ")}
			title={label}
			aria-label={label}
			{...rest}
		>
			{icon}
		</button>
	),
} as MithrilJSXComponent<
	{
		icon: Child;
		label: string;
		danger?: boolean;
		class?: string;
	} & m.Attributes
>;

/** The link twin of `IconButton`: an icon that navigates. */
export const IconLink = {
	view: ({ attrs: { icon, label, href, class: cls, ...rest } }) => (
		<a
			class={["icon-link", cls ?? ""].filter(Boolean).join(" ")}
			href={href}
			title={label}
			aria-label={label}
			{...rest}
		>
			{icon}
		</a>
	),
} as MithrilJSXComponent<
	{ icon: Child; label: string; href: string; class?: string } & m.Attributes
>;
