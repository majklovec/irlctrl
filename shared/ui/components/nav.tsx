/** @jsx m */
/* The control server's main menu + profile menu. */
import m from "mithril";
import { apiJson, apiTry } from "../api_client";
import { t } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";

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
	active: "devices" | "dashboards" | "overlays" | "assets" | "profile";
}> = {
	oncreate() {
		// The menu label is the session user's login name.
		void apiTry<{ user?: string }>("/api/whoami").then((body) => {
			if (body?.user) {
				profile.username = body.user;
				m.redraw();
			}
		});
		// Close the menu on any click outside of it.
		document.addEventListener("click", closeProfileMenu);
	},
	onremove() {
		document.removeEventListener("click", closeProfileMenu);
	},
	view: ({ attrs: { active } }) => (
		<span>
			<a
				href="/devices/"
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
			<a
				href="/overlays/"
				class={active === "overlays" ? "nav-link active" : "nav-link"}
				aria-current={active === "overlays" ? "page" : undefined}
			>
				{t("overlay.title")}
			</a>
			<a
				href="/assets/"
				class={active === "assets" ? "nav-link active" : "nav-link"}
				aria-current={active === "assets" ? "page" : undefined}
			>
				{t("assets.title")}
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
	active: "devices" | "dashboards" | "overlays" | "assets" | "profile";
}>;

/** Drop the session cookie, then back to the login page. */
async function logout(): Promise<void> {
	try {
		await apiJson("/api/logout", { method: "POST" });
	} finally {
		location.replace("/login");
	}
}
