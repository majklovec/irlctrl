/* Registration page: create a profile, then hand off to the login page. The
 * first account bootstraps as admin; everyone after needs an invite, which the
 * /api/register/status probe (plus a ?invite= link) drives showing the field. */

import { ApiError, apiJson } from "@ui/api_client";
import { Card, Field, Footer, Input } from "@ui/components/";
import { i18nReady, LanguageSelect, t } from "@ui/i18n";
import { mountPage } from "@ui/util";
import m from "mithril";
import logoUrl from "../../shared/assets/img/logo-irlctrl.png";

/** Server /api/register error strings → i18n keys (unknowns pass through). */
function mapError(message: string): string {
	switch (message) {
		case "Invitation code required":
			return "register.errors.inviteRequired";
		case "Invalid invitation code":
			return "register.errors.inviteInvalid";
		case "Invitation already used":
			return "register.errors.inviteUsed";
		case "Invitation expired":
			return "register.errors.inviteExpired";
		case "That username is already taken":
			return "register.errors.usernameTaken";
		default:
			return message;
	}
}

const state = {
	username: "",
	invite: new URLSearchParams(location.search).get("invite") ?? "",
	password: "",
	confirm: "",
	busy: false,
	// false = no message; otherwise an i18n key (or the raw server text).
	error: false as false | string,
	// Whether an invite code is required (any account already exists). Kept true
	// until proven otherwise — safer to show the field than skip sign-up.
	needsInvite: true,
	statusLoaded: false,
};

/** Client-side preflight shared with the submit guard. */
function valid(): boolean {
	return (
		state.username.trim().length > 0 &&
		state.password.length >= 8 &&
		state.password === state.confirm
	);
}

/** Ask the server whether an invite is required (any account exists yet). On
 * failure the field stays visible — safer than silently allowing sign-up. */
async function loadRegisterStatus(): Promise<void> {
	try {
		const body = await apiJson<{ needsInvite: boolean }>(
			"/api/register/status",
		);
		state.needsInvite = body.needsInvite;
	} catch {
		/* keep needsInvite true */
	} finally {
		state.statusLoaded = true;
		m.redraw();
	}
}

/** POST the details to /api/register; on success the server created the
 * account and we head to the login page (flagged so it can confirm). */
async function submit(ev: Event): Promise<void> {
	ev.preventDefault();
	if (state.busy) return;
	if (!valid()) {
		state.error = "register.error";
		m.redraw();
		return;
	}
	state.busy = true;
	state.error = false;
	m.redraw();
	try {
		await apiJson("/api/register", {
			body: {
				username: state.username.trim(),
				password: state.password,
				invite: state.invite.trim(),
			},
		});
		// Forward the ?next= target (if we were bounced from a protected
		// route) so the login page can return there after signing in.
		const next = new URLSearchParams(location.search).get("next") ?? "";
		location.replace(
			`/login?registered=1${next ? `&next=${encodeURIComponent(next)}` : ""}`,
		);
	} catch (err) {
		// the server's error string maps to a translated message; anything
		// else (network, non-JSON) keeps the generic one
		state.error =
			err instanceof ApiError &&
			err.status > 0 &&
			!err.message.startsWith("HTTP ")
				? mapError(err.message)
				: "register.error";
	} finally {
		state.busy = false;
		m.redraw();
	}
}

const App: m.Component = {
	oncreate() {
		void loadRegisterStatus();
	},
	view: () => (
		<div class="login-page">
			<Card>
				<img class="login-logo" src={logoUrl} alt="IRLCTRL" />
				<div class="login-head">
					<h2>{t("register.title")}</h2>
					<LanguageSelect />
				</div>
				{state.statusLoaded && !state.needsInvite ? (
					<p>{t("register.firstAdminInfo")}</p>
				) : null}
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
					{!state.statusLoaded || state.needsInvite ? (
						<Field
							label={t("register.invite")}
							control={
								<Input
									target={state}
									prop="invite"
									type="text"
									placeholder={t("register.invitePlaceholder")}
									autocomplete="off"
									disabled={state.busy}
								/>
							}
						/>
					) : null}
					<Field
						label={t("register.password")}
						control={
							<Input
								target={state}
								prop="password"
								type="password"
								autocomplete="new-password"
								disabled={state.busy}
							/>
						}
					/>
					<Field
						label={t("register.confirm")}
						control={
							<Input
								target={state}
								prop="confirm"
								type="password"
								autocomplete="new-password"
								disabled={state.busy}
							/>
						}
					/>
					<div class="actions">
						<button type="submit" disabled={state.busy}>
							{t("register.title")}
						</button>
					</div>
					{state.error ? <p class="error">{t(state.error)}</p> : null}
				</form>
				{state.statusLoaded && state.needsInvite ? (
					<div class="login-alt">
						<a href="/login">{t("register.back")}</a>
					</div>
				) : null}
			</Card>
			<Footer />
		</div>
	),
};

void mountPage(() => t("register.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
