/** @jsx m */
/* Page skeleton: header (brand, title, nav, optional language selector,
 * actions), optional toolbar strip, main content and the version footer. */
import m from "mithril";
import logoUrl from "../../assets/img/logo-irlctrl-64.png";
import { APP_VERSION } from "../../../generated/version";
import { LanguageSelect } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";

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
 * home), then carries the optional main menu, and the page's own `headerRight`
 * actions on its right edge. The header language selector is opt-in
 * (`showLanguage`): the control server keeps it in the Profile page, the
 * device client passes it to every device page. */
export const Page = {
	view: (v) => [
		<header>
			<a class="brand" href="/" aria-label="IRLCTRL">
				<img
					class="brand-logo"
					src={logoUrl}
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
					{v.attrs.showLanguage ? <LanguageSelect /> : null}
					{v.attrs.headerRight}
				</span>,
			]}
		</header>,
		v.attrs.toolbar !== undefined ? (
			<div class="page-subbar">{v.attrs.toolbar}</div>
		) : null,
		<main>{v.children}</main>,
		<Footer />,
	],
} as MithrilJSXComponent<{
	title?: m.Children;
	nav?: m.Children;
	/** Render the header language selector (the control server keeps it in
	 * the Profile page; the device client passes it per page). */
	showLanguage?: boolean;
	headerRight?: m.Children;
	/** Full-width strip rendered flush between the header and the content. */
	toolbar?: m.Children;
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
