/* Sign-in page: exchanges a username + password for the session cookie. */

import { Card, Field, Footer, Input } from "@ui/components/";
import m from "mithril";
import logoUrl from "../../../shared/assets/img/logo-irlctrl.png";
import { apiJson } from "../../../shared/ui/api_client";
import { i18nReady, LanguageSelect, t } from "../../../shared/ui/i18n";
import { mountPage } from "../../../shared/ui/util";

// Show a one-time "account created" note when we just came back from /register.
const registered = new URLSearchParams(location.search).has("registered");

const state = {
	username: "",
	password: "",
	busy: false,
	error: false,
};

/** POST the credentials to /api/login; on success the server sets the
 * session cookie and we land on the device list. */
async function submit(ev: Event): Promise<void> {
	ev.preventDefault();
	if (state.busy) return;
	state.busy = true;
	state.error = false;
	m.redraw();
	try {
		await apiJson("/api/login", {
			body: { username: state.username, password: state.password },
		});
		location.replace("/");
	} catch {
		state.error = true;
	} finally {
		state.busy = false;
		m.redraw();
	}
}

const App: m.Component = {
	view: () => (
		<div class="login-page">
			<Card>
				<img class="login-logo" src={logoUrl} alt="IRLCTRL" />
				<div class="login-head">
					<h2>{t("login.title")}</h2>
					<LanguageSelect />
				</div>
				<form onsubmit={submit}>
					<Field
						label={t("login.username")}
						control={
							<Input
								target={state}
								prop="username"
								autocomplete="username"
								autofocus
								disabled={state.busy}
							/>
						}
					/>
					<Field
						label={t("login.password")}
						control={
							<Input
								target={state}
								prop="password"
								type="password"
								autocomplete="current-password"
								disabled={state.busy}
							/>
						}
					/>
					<div class="actions">
						<button type="submit" disabled={state.busy}>
							{t("login.submit")}
						</button>
					</div>
					{registered ? <p class="ok">{t("login.registered")}</p> : null}
					{state.error ? <p class="error">{t("login.error")}</p> : null}
				</form>
				<div class="login-alt">
					<a href="/register">{t("login.register")}</a>
				</div>
			</Card>
			<Footer />
		</div>
	),
};

void mountPage(() => t("login.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
