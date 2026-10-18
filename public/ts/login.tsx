/* Sign-in page: exchanges a username + password for the session cookie. */
import m from "mithril";
import {
  Card,
  Field,
  Input,
} from "./components/ui";
import { i18nReady, LanguageSelect, t } from "./i18n";
import { mountPage } from "./util";

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
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: state.username,
        password: state.password,
      }),
    });
    if (!res.ok) {
      state.error = true;
      return;
    }
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
    <div class={"login-page"}>
      <Card>
        <div class={"login-lang"}>
          <LanguageSelect />
        </div>
        <h2>{t("login.title")}</h2>
        <form onsubmit={submit}>
          <Field
            label={t("login.username")}
            control={
              <Input
                target={state}
                prop="username"
                autocomplete={"username"}
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
                type={"password"}
                autocomplete={"current-password"}
                disabled={state.busy}
              />
            }
          />
          <div class={"actions"}>
            <button type={"submit"} disabled={state.busy}>
              {t("login.submit")}
            </button>
          </div>
          {registered ? <p class={"ok"}>{t("login.registered")}</p> : null}
          {state.error ? <p class={"error"}>{t("login.error")}</p> : null}
        </form>
        <div class={"login-alt"}>
          <a href={"/register"}>{t("login.register")}</a>
        </div>
      </Card>
    </div>
  ),
};

void mountPage(() => t("login.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
