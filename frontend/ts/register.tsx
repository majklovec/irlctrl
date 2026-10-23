/* Registration page: create a profile, then hand off to the login page. The
 * first account bootstraps as admin; everyone after needs an invite, which the
 * /api/register/status probe (plus a ?invite= link) drives showing the field. */
import m from "mithril";
import { Card, Field, Input } from "./components/ui";
import { i18nReady, LanguageSelect, t } from "./i18n";
import { mountPage } from "./util";

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
		const res = await fetch("/api/register/status");
		if (res.ok) {
			const body = (await res.json()) as { needsInvite: boolean };
			state.needsInvite = body.needsInvite;
		}
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
		const res = await fetch("/api/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				username: state.username.trim(),
				password: state.password,
				invite: state.invite.trim(),
			}),
		});
		if (!res.ok) {
			let message = "register.error";
			try {
				const body = (await res.json()) as { error?: string };
				if (body.error) message = mapError(body.error);
			} catch {
				/* keep the generic message */
			}
			state.error = message;
			return;
		}
		location.replace("/login?registered=1");
	} catch {
		state.error = "register.error";
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
				<div class="login-lang">
					<LanguageSelect />
				</div>
				<h2>{t("register.title")}</h2>
				{state.statusLoaded && !state.needsInvite ? (
					<p>{t("register.firstAdminInfo")}</p>
				) : null}
				<form onsubmit={submit}>
					<Field
						label={t("register.username")}
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
							{t("register.submit")}
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
		</div>
	),
};

void mountPage(() => t("register.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
