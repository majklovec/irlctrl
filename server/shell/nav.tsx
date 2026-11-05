/** @jsx m */
/* The control server's main menu + profile menu.
 * The entity entries are rendered from the generated page manifest
 * (server/core/generated/pages.ts) — adding a page slice adds its menu
 * entry with no edit to this file. The profile menu (account, sign out)
 * is shell-owned and stays hardcoded here. */
import m from "mithril";
import { apiJson, apiTry } from "@ui/api_client";
import { t } from "@ui/i18n";
import type { MithrilJSXComponent } from "@ui/jsx";
import { MENUS } from "../../generated/pages";

/** Menu items in display order — the generated manifest is only sorted by
 * page id, mirroring the server registry's menu.order ordering (default 100). */
const MENU_ITEMS = [...MENUS].sort(
	(a, b) => (a.order ?? 100) - (b.order ?? 100),
);

/** Session user shown in the profile menu + whether its menu is open. */
const profile = { username: null as string | null, open: false };

function closeProfileMenu(): void {
	if (profile.open) {
		profile.open = false;
		m.redraw();
	}
}

const ServerNavComponent: m.Component<{ active?: string }> = {
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
			{MENU_ITEMS.map((item) => (
				<a
					key={item.id}
					href={item.path}
					class={active === item.id ? "nav-link active" : "nav-link"}
					aria-current={active === item.id ? "page" : undefined}
				>
					{t(item.labelKey)}
				</a>
			))}
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
	active?: string;
}>;

/** Drop the session cookie, then back to the login page. */
async function logout(): Promise<void> {
	try {
		await apiJson("/api/logout", { method: "POST" });
	} finally {
		location.replace("/login");
	}
}
