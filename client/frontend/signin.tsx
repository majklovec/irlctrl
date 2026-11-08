/* Device sign-in page: exchanges the username + password registered in the
 * setup wizard for the session cookie, then lands on the main page. */

import { apiJson } from "@ui/api_client";
import { Card, Field, Input } from "@ui/components/";
import { i18nReady, LanguageSelect, t } from "@ui/i18n";
import { mountPage } from "@ui/util";
import m from "mithril";
import logoUrl from "../../shared/assets/img/logo-irlctrl.png";

const state = {
	username: "",
	password: "",
	busy: false,
	error: false,
};

/** POST the credentials to /login; on success the server sets the
 * session cookie and we land on the main page. */
async function attemptLogin(): Promise<void> {
	if (state.busy) return;
	state.busy = true;
	state.error = false;
	m.redraw();
	try {
		await apiJson("/login", {
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

function submit(ev: Event): void {
	ev.preventDefault();
	void attemptLogin();
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
					{state.error ? <p class="error">{t("login.error")}</p> : null}
				</form>
			</Card>
		</div>
	),
};

void mountPage(() => t("login.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
