/* Registration page: create a profile, then hand off to the login page. */
import m from "mithril";
import {
  Card,
  Field,
  Input,
} from "./components/ui";
import { i18nReady, LanguageSelect, t } from "./i18n";
import { mountPage } from "./util";

const state = {
  username: "",
  password: "",
  confirm: "",
  busy: false,
  error: false,
};

/** Client-side preflight shared with the submit guard. */
function valid(): boolean {
  return (
    state.username.trim().length > 0 &&
    state.password.length >= 8 &&
    state.password === state.confirm
  );
}

/** POST the details to /api/register; on success the server created the
 * account and we head to the login page (flagged so it can confirm). */
async function submit(ev: Event): Promise<void> {
  ev.preventDefault();
  if (state.busy) return;
  if (!valid()) {
    state.error = true;
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
      }),
    });
    if (!res.ok) {
      state.error = true;
      return;
    }
    location.replace("/login?registered=1");
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
        <h2>{t("register.title")}</h2>
        <form onsubmit={submit}>
          <Field
            label={t("register.username")}
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
            label={t("register.password")}
            control={
              <Input
                target={state}
                prop="password"
                type={"password"}
                autocomplete={"new-password"}
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
                type={"password"}
                autocomplete={"new-password"}
                disabled={state.busy}
              />
            }
          />
          <div class={"actions"}>
            <button type={"submit"} disabled={state.busy}>
              {t("register.submit")}
            </button>
          </div>
          {state.error ? <p class={"error"}>{t("register.error")}</p> : null}
        </form>
        <div class={"login-alt"}>
          <a href={"/login"}>{t("register.back")}</a>
        </div>
      </Card>
    </div>
  ),
};

void mountPage(() => t("register.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
