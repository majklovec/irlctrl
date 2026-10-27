/* Shared building blocks (header, cards, badges, definition lists, bound form controls)
 * for Mithril JSX views. These helpers keep markup consistent between pages. */
import m from "mithril";
import { APP_VERSION } from "../../../generated/version";
import { LanguageSelect, t } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";
import type { Child } from "../util";

export type { Child };

// -- Page skeleton -----------------------------------------------------------------

/** Page footer: the app name and the package.json version of this build. */
const FooterComponent: m.Component = {
	view: () => (
		<footer class="page-footer muted">
			IRLCTRL <span class="app-version">v{APP_VERSION}</span>
		</footer>
	),
};
export const Footer = FooterComponent as MithrilJSXComponent;

/** <header> + <main> + <footer> page skeleton. The header leads with the brand logo (linking
 * home), then carries the optional main menu, and the language selector plus the
 * page's own `headerRight` actions on its right edge. */
export const Page = {
	view: (v) => [
		<header>
			<a class="brand" href="/" aria-label="IRLCTRL">
				<img
					class="brand-logo"
					src="/img/logo-irlctrl-64.png"
					alt="IRLCTRL"
					width={32}
					height={32}
				/>
			</a>
			{v.attrs.title && <h1>{v.attrs.title}</h1>}
			{[
				v.attrs.nav !== undefined ? (
					<nav class="main-nav">{v.attrs.nav}</nav>
				) : null,
				<span class="actions">
					<LanguageSelect />
					{v.attrs.headerRight}
				</span>,
			]}
		</header>,
		<main>{v.children}</main>,
		<Footer />,
	],
} as MithrilJSXComponent<{
	title?: m.Children;
	nav?: m.Children;
	headerRight?: m.Children;
}>;

export const TitleWithBack = {
	view: ({ attrs: { href, backLabel }, children }) => [
		href !== undefined ? (
			<a
				class="icon-link page-back"
				href={href}
				title={backLabel}
				aria-label={backLabel}
			>
				<span class="sr-only">{backLabel}</span>
				<svg
					width={16}
					height={16}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width={1.75}
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M10 12L6 8l4-4" />
				</svg>
			</a>
		) : null,
		" ",
		children,
	],
} as MithrilJSXComponent<{ href?: string; backLabel: string }>;

// -- Navigation --------------------------------------------------------------------

/** Session user shown in the profile menu + whether its menu is open. */
const profile = { username: null as string | null, open: false };

function closeProfileMenu(): void {
	if (!profile.open) return;
	profile.open = false;
	m.redraw();
}

/** Main menu of the control server: the device list, the dashboards page,
 * and the profile menu (profile page + sign out). */
const ServerNavComponent: m.Component<{
	active: "devices" | "dashboards" | "profile";
}> = {
	oncreate() {
		// The menu label is the session user's login name.
		void fetch("/api/whoami")
			.then((r) => (r.ok ? (r.json() as Promise<{ user?: string }>) : null))
			.then((body) => {
				if (body?.user) {
					profile.username = body.user;
					m.redraw();
				}
			})
			.catch(() => {});
		// Close the menu on any click outside of it.
		document.addEventListener("click", closeProfileMenu);
	},
	onremove() {
		document.removeEventListener("click", closeProfileMenu);
	},
	view: ({ attrs: { active } }) => (
		<span>
			<a
				href="/"
				class={active === "devices" ? "nav-link active" : "nav-link"}
				aria-current={active === "devices" ? "page" : undefined}
			>
				{t("mgmt.devices")}
			</a>
			<a
				href="/dashboards/"
				class={active === "dashboards" ? "nav-link active" : "nav-link"}
				aria-current={active === "dashboards" ? "page" : undefined}
			>
				{t("dash.title")}
			</a>
			<span
				class={profile.open ? "profile-menu open" : "profile-menu"}
				onclick={(ev: Event) => ev.stopPropagation()}
			>
				<button
					type="button"
					class="profile-menu-trigger"
					aria-label={profile.username ?? t("nav.profile")}
					title={profile.username ?? t("nav.profile")}
					aria-haspopup="menu"
					aria-expanded={profile.open}
					onclick={() => {
						profile.open = !profile.open;
						m.redraw();
					}}
				>
					{profile.username
						? Array.from(profile.username).slice(0, 2).join("").toUpperCase()
						: "…"}
				</button>
				{profile.open ? (
					<span class="profile-menu-dropdown" role="menu">
						<a role="menuitem" href="/profile">
							{t("nav.profile")}
						</a>
						<button type="button" role="menuitem" onclick={() => void logout()}>
							{t("nav.logout")}
						</button>
					</span>
				) : null}
			</span>
		</span>
	),
};
export const ServerNav = ServerNavComponent as MithrilJSXComponent<{
	active: "devices" | "dashboards" | "profile";
}>;

/** Drop the session cookie, then back to the login page. */
async function logout(): Promise<void> {
	try {
		await fetch("/api/logout", { method: "POST" });
	} finally {
		location.replace("/login");
	}
}

// -- Cards -------------------------------------------------------------------------

export interface CardProps {
	/** Bare <h2> title. Use `headActions` for the title-plus-actions row. */
	title?: Child;
	/** Actions on the right of the title row (.card-head). */
	headActions?: m.Children;
	/** Extra class(es) on the <section.card> root (module scoping, e.g. `mod-modems`). */
	class?: string;
}

export const Card = {
	view: ({ attrs: { title, headActions, class: extra }, children }) => (
		<section class={extra === undefined ? "card" : `card ${extra}`}>
			{[
				title === undefined ? null : headActions === undefined ? (
					<h2>{title}</h2>
				) : (
					<div class="card-head">
						<h2>{title}</h2>
						<div class="actions">{headActions}</div>
					</div>
				),
				children, // nested arrays are flattened by mithril
			]}
		</section>
	),
} as MithrilJSXComponent<CardProps>;

// -- Badges ------------------------------------------------------------------------

export type BadgeKind = "on" | "off" | "warn" | "";

export const Badge = {
	view: ({ attrs: { text, label = "", kind = "" } }) => (
		<span class={`badge ${kind}`.trim()} title={label || undefined}>
			{text}
		</span>
	),
} as MithrilJSXComponent<{ text: string; label?: string; kind?: BadgeKind }>;

/** "connected" / "disconnected" header badge. */
export const ConnectionBadge = {
	view: ({ attrs: { connected } }) =>
		connected ? (
			<Badge text={t("dev.connected")} kind="on" />
		) : (
			<Badge text={t("dev.disconnected")} kind="off" />
		),
} as MithrilJSXComponent<{ connected: boolean }>;

// -- Definition lists / tables -----------------------------------------------------

/** <dl> of dt/dd rows; empty values render "—". */
export const DefinitionList = {
	view: ({ attrs: { rows } }) => (
		<dl>{rows.flatMap(([k, v]) => [<dt>{k}</dt>, <dd>{v ?? "—"}</dd>])}</dl>
	),
} as MithrilJSXComponent<{ rows: [string, Child][] }>;

/** A <table> of th/td rows (dashboard widget bodies share this shape). */
export const WidgetTable = {
	view: ({ attrs: { rows } }) => (
		<table class="dash-table">
			<tbody>
				{rows.map(([label, value], i) => (
					<tr key={i}>
						<th>{label}</th>
						<td>{value}</td>
					</tr>
				))}
			</tbody>
		</table>
	),
} as MithrilJSXComponent<{ rows: [string, Child][] }>;

// -- Form building blocks ----------------------------------------------------------

/** A <label> with a caption above its control; extra attrs (`class`, `hidden`, …) pass through. */
export const Field = {
	view: ({ attrs: { label, control, ...extra } }) => (
		// biome-ignore lint/a11y/noLabelWithoutControl: <explanation>
		<label {...extra}>
			{label}
			{control}
		</label>
	),
} as MithrilJSXComponent<{ label: Child; control: m.Children } & m.Attributes>;

/** Numeric bound input wrapped in a standard form Field label/control row. */
export const NumberField = {
	view: ({
		attrs: { label, target, prop, min, max, placeholder, step, ...fieldAttrs },
	}) => (
		<Field
			{...fieldAttrs}
			label={label}
			control={
				target ? (
					<Input
						target={target}
						prop={prop}
						{...numberAttrs(min, max, placeholder, step)}
					/>
				) : null
			}
		/>
	),
} as MithrilJSXComponent<
	{
		label: Child;
		target?: object;
		prop: string;
		min: number;
		max: number;
		placeholder?: string;
		step?: number;
	} & m.Attributes
>;

/** A checkbox (or radios) with its caption after it. */
export const CheckField = {
	view: ({ attrs: { label, control, class: extraClass, ...extra } }) => (
		// biome-ignore lint/a11y/noLabelWithoutControl: <explanation>
		<label {...extra} class={extraClass ? `${extraClass} check` : "check"}>
			{control}
			{label}
		</label>
	),
} as MithrilJSXComponent<
	{ label: Child; control: m.Children; class?: string } & m.Attributes
>;

/** <button type="button">; pass `type: "submit"` for a form's default action. */
export const Button = {
	view: ({ attrs: { label, ...rest } }) => (
		<button type="button" {...rest}>
			{label}
		</button>
	),
} as MithrilJSXComponent<{ label: Child } & m.Attributes>;

/** <div.actions> row of buttons. */
export const Actions = {
	view: ({ children }) => <div class="actions">{children}</div>,
} as MithrilJSXComponent<{ children?: m.Children }>;

/** Line break inside a flex-wrapped form. */
export const Break = {
	view: (_v) => <div class="break" />,
} as MithrilJSXComponent<{ children?: m.Children }>;

/** Titled full-width group of related form fields (<fieldset> + <legend>). */
export const FieldGroup = {
	view: ({ attrs: { legend }, children }) => (
		<fieldset class="group">
			<legend>{legend}</legend>
			{children}
		</fieldset>
	),
} as MithrilJSXComponent<{ legend: Child }>;

/** <option>s from [value, label] pairs. */
export const Options = {
	view: ({ attrs: { pairs } }) =>
		pairs.map(([value, label]) => (
			<option key={value} value={value}>
				{label}
			</option>
		)),
} as MithrilJSXComponent<{ pairs: readonly (readonly [string, string])[] }>;

/** <form> whose submit runs `onSubmit` instead of navigating. */
export const Form = {
	view: ({ attrs: { onSubmit, ...rest }, children }) => (
		<form
			{...rest}
			onsubmit={(e: Event) => {
				e.preventDefault();
				onSubmit?.();
			}}
		>
			{children}
		</form>
	),
} as MithrilJSXComponent<{ onSubmit?: () => void } & m.Attributes>;

// -- Controls two-way bound to a property of a state object ------------------------

/** Keys of `T` whose values are `V`. */
export type KeysOf<T, V> = {
	[K in keyof T]-?: T[K] extends V ? K : never;
}[keyof T] &
	string;

/** Shared props for the bound controls below. `prop` names a property on `target`. */
export interface BoundProps {
	target: object;
	prop: string;
}

/** <input> bound to the string `target[prop]`; `name` defaults to `prop`. */
export const Input = {
	view: ({ attrs: { target, prop, onChange, ...rest } }) => {
		const state = target as Record<string, unknown>;
		return (
			<input
				name={prop}
				{...rest}
				value={state[prop] as string}
				oninput={(e: Event) => {
					const value = (e.target as HTMLInputElement).value;
					state[prop] = value;
					onChange?.(value);
				}}
			/>
		);
	},
} as MithrilJSXComponent<
	BoundProps & { onChange?: (value: string) => void } & m.Attributes
>;

/** <select> bound to the string `target[prop]`. */
export const Select = {
	view: ({ attrs: { target, prop, onChange, ...rest }, children }) => {
		const state = target as Record<string, unknown>;
		return (
			<select
				name={prop}
				{...rest}
				value={state[prop] as string}
				onchange={(e: Event) => {
					const value = (e.target as HTMLSelectElement).value;
					state[prop] = value;
					onChange?.(value);
				}}
			>
				{children}
			</select>
		);
	},
} as MithrilJSXComponent<
	BoundProps & { onChange?: (value: string) => void } & m.Attributes
>;

/** Checkbox bound to the boolean `target[prop]`. */
export const Checkbox = {
	view: ({ attrs: { target, prop, onChange, ...rest } }) => {
		const state = target as Record<string, unknown>;
		return (
			<input
				type="checkbox"
				name={prop}
				{...rest}
				checked={state[prop] as boolean}
				onchange={(e: Event) => {
					const checked = (e.target as HTMLInputElement).checked;
					state[prop] = checked;
					onChange?.(checked);
				}}
			/>
		);
	},
} as MithrilJSXComponent<
	BoundProps & { onChange?: (checked: boolean) => void } & m.Attributes
>;

/** Attributes of a numeric <input>. (Plain function — it returns attrs, not a vnode.) */
export const numberAttrs = (
	min: number,
	max: number,
	placeholder?: string,
	step?: number,
): m.Attributes => ({
	type: "number",
	min,
	max,
	step,
	placeholder,
});
