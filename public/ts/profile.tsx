/* Profile page: change the login password and manage the device tokens. */
import m from "mithril";
import {
  Actions,
  Button,
  Card,
  Field,
  FieldGroup,
  Form,
  Input,
  Page,
  ServerNav,
} from "./components/ui";
import { i18nReady, t } from "./i18n";
import { mountPage } from "./util";

interface Token {
  id: number;
  token: string;
  createdAt: string;
}

const state = {
  username: "",
  tokens: undefined as Token[] | undefined,

  current: "",
  next: "",
  confirm: "",
  pwBusy: false,
  pwOk: false,
  pwError: false,

  newToken: undefined as Token | undefined,
  tokenBusy: false,
  removing: false,
};

function render(): void {
  m.redraw();
}

/** Load the profile (username + existing tokens). */
async function load(): Promise<void> {
  try {
    const res = await fetch("/api/profile");
    if (!res.ok) return;
    const body = (await res.json()) as { username: string; tokens: Token[] };
    state.username = body.username;
    state.tokens = body.tokens;
    render();
  } catch {
    render();
  }
}

/** POST /api/profile/password, then clear the fields. */
function changePassword(): void {
  if (state.pwBusy) return;
  if (state.next !== state.confirm) {
    state.pwOk = false;
    state.pwError = true;
    render();
    return;
  }
  state.pwBusy = true;
  state.pwOk = false;
  state.pwError = false;
  render();
  void fetch("/api/profile/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ current: state.current, new: state.next }),
  })
    .then(async (res) => {
      if (res.ok) {
        state.pwOk = true;
        state.current = "";
        state.next = "";
        state.confirm = "";
      } else {
        state.pwError = true;
      }
    })
    .catch(() => {
      state.pwError = true;
    })
    .finally(() => {
      state.pwBusy = false;
      render();
    });
}

/** POST /api/profile/tokens: the response carries the full token value (the
 * only time the server ever returns one), so it is shown for copying. */
function addToken(): void {
  if (state.tokenBusy) return;
  state.tokenBusy = true;
  state.newToken = undefined;
  render();
  void fetch("/api/profile/tokens", { method: "POST" })
    .then(async (res) => {
      if (!res.ok) throw new Error();
      state.newToken = ((await res.json()) as { token: Token }).token;
    })
    .catch(() => {})
    .finally(() => {
      state.tokenBusy = false;
      render();
    });
}

/** DELETE /api/profile/tokens/<id>, then drop the row from the list. */
function removeToken(id: number): void {
  if (state.removing) return;
  state.removing = true;
  render();
  void fetch(`/api/profile/tokens/${id}`, { method: "DELETE" })
    .then((res) => {
      if (res.ok && state.tokens)
        state.tokens = state.tokens.filter((tk) => tk.id !== id);
    })
    .catch(() => {})
    .finally(() => {
      state.removing = false;
      render();
    });
}

/** Copy the token value to the clipboard (best effort, no toast). */
function copyToken(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => {});
}

const App: m.Component = {
  oncreate() {
    void load();
  },
  view: () => (
    <Page title={t("profile.title")} nav={<ServerNav active="profile" />}>
      <Card title={t("profile.password")}>
        <Form onSubmit={changePassword}>
          <FieldGroup legend={t("profile.password.change")}>
            <Field
              label={t("profile.password.current")}
              control={
                <Input
                  target={state}
                  prop="current"
                  type={"password"}
                  autocomplete={"current-password"}
                  disabled={state.pwBusy}
                />
              }
            />
            <Field
              label={t("profile.password.new")}
              control={
                <Input
                  target={state}
                  prop="next"
                  type={"password"}
                  autocomplete={"new-password"}
                  disabled={state.pwBusy}
                />
              }
            />
            <Field
              label={t("profile.password.confirm")}
              control={
                <Input
                  target={state}
                  prop="confirm"
                  type={"password"}
                  autocomplete={"new-password"}
                  disabled={state.pwBusy}
                />
              }
            />
            {state.pwOk ? (
              <p class={"ok"}>{t("profile.password.saved")}</p>
            ) : null}
            {state.pwError ? (
              <p class={"error"}>{t("profile.password.error")}</p>
            ) : null}
            <Actions>
              <button type={"submit"} disabled={state.pwBusy}>
                {t("profile.password.submit")}
              </button>
            </Actions>
          </FieldGroup>
        </Form>
      </Card>
      <Card
        title={t("profile.tokens.title")}
        headActions={
          <Button
            label={t("profile.tokens.add")}
            disabled={state.tokenBusy}
            onClick={addToken}
          />
        }
      >
        {state.newToken ? (
          <div class={"token-item new"}>
            <code
              class={"token-value"}
              title={t("profile.tokens.copy")}
              onClick={() => copyToken(state.newToken!.token)}
            >
              {state.newToken.token}
            </code>
            <span class={"muted"}>{new Date(state.newToken.createdAt).toLocaleString()}</span>
          </div>
        ) : null}
        {state.tokens === undefined ? (
          <p class={"muted"}>{t("mgmt.loading")}</p>
        ) : state.tokens.length === 0 ? (
          <p class={"muted"}>{t("profile.tokens.empty")}</p>
        ) : (
          state.tokens.map((tk) => (
            <div class={"token-item"} key={tk.id}>
              <code
                class={"token-value"}
                title={t("profile.tokens.copy")}
                onClick={() => copyToken(tk.token)}
              >
                {tk.token}
              </code>
              <span class={"muted"}>{new Date(tk.createdAt).toLocaleString()}</span>
              <Button
                class={"danger"}
                label={t("profile.tokens.remove")}
                disabled={state.removing}
                onClick={() => removeToken(tk.id)}
              />
            </div>
          ))
        )}
      </Card>
    </Page>
  ),
};

void mountPage(() => t("profile.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
