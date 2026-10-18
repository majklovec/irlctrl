/* Profile page: change the login password and manage the device tokens. */
import m from "mithril";
import {
  Actions,
  Badge,
  Button,
  Card,
  Field,
  FieldGroup,
  Form,
  Input,
  Page,
  ServerNav,
} from "./components/ui";
import { actionIcon } from "./components/icons";
import { i18nReady, t } from "./i18n";
import { mountPage } from "./util";

interface Token {
  id: number;
  token: string;
  createdAt: string;
}

interface Invitation {
  code: string;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
  used_by: string | null;
  created_by: string | null;
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

  tokenBusy: false,
  removing: false,

  admin: false,
  invitations: undefined as Invitation[] | undefined,
  creatingInvite: false,
};

function render(): void {
  m.redraw();
}

function mergeTokens(loaded: Token[], current: Token[] | undefined): Token[] {
  if (!current) return loaded;
  const loadedIds = new Set(loaded.map(({ id }) => id));
  return [...loaded, ...current.filter(({ id }) => !loadedIds.has(id))];
}

/** Load the profile (username, admin flag + existing tokens), and the
 * invitation history when this user is an admin. */
async function load(): Promise<void> {
  try {
    const res = await fetch("/api/profile");
    if (!res.ok) return;
    const body = (await res.json()) as {
      username: string;
      admin: boolean;
      tokens: Token[];
    };
    state.username = body.username;
    state.admin = body.admin;
    state.tokens = mergeTokens(body.tokens, state.tokens);
    render();
    if (body.admin) void loadInvitations();
  } catch {
    render();
  }
}

/** GET /api/invitations → the admin's invitation history (newest first). */
async function loadInvitations(): Promise<void> {
  try {
    const res = await fetch("/api/invitations");
    if (!res.ok) return;
    const body = (await res.json()) as { invitations: Invitation[] };
    state.invitations = body.invitations;
    render();
  } catch {
    render();
  }
}

/** POST /api/invitations to mint a code, then refresh the list. */
function mintInvite(): void {
  if (state.creatingInvite) return;
  state.creatingInvite = true;
  render();
  void fetch("/api/invitations", { method: "POST" })
    .then(async (res) => {
      if (res.ok) await loadInvitations();
    })
    .catch(() => {})
    .finally(() => {
      state.creatingInvite = false;
      render();
    });
}

/** Copy the invite code to the clipboard (best effort, no toast). */
function copyInvite(code: string): void {
  void navigator.clipboard?.writeText(code).catch(() => {});
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
  render();
  void fetch("/api/profile/tokens", { method: "POST" })
    .then(async (res) => {
      if (!res.ok) throw new Error();
      const token = ((await res.json()) as { token: Token }).token;
      state.tokens = [...(state.tokens ?? []), token];
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
            onclick={addToken}
          />
        }
      >
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
                onclick={() => copyToken(tk.token)}
              >
                {tk.token}
              </code>
              <span class={"muted"}>{new Date(tk.createdAt).toLocaleString()}</span>
              <Button
                class={"icon-link dash-delete"}
                label={actionIcon("delete")}
                title={t("profile.tokens.remove")}
                aria-label={t("profile.tokens.remove")}
                disabled={state.removing}
                onclick={() => removeToken(tk.id)}
              />
            </div>
          ))
        )}
      </Card>
      {state.admin ? (
        <Card
          title={t("profile.invitations.title")}
          headActions={
            <Button
              label={
                state.creatingInvite
                  ? t("invitations.generating")
                  : t("invitations.create")
              }
              disabled={state.creatingInvite}
              onclick={mintInvite}
            />
          }
        >
          {state.invitations === undefined ? (
            <p class={"muted"}>{t("mgmt.loading")}</p>
          ) : state.invitations.length === 0 ? (
            <p class={"muted"}>{t("profile.invitations.empty")}</p>
          ) : (
            <table class={"dash-table"}>
              <thead>
                <tr>
                  <th>{t("invitations.code")}</th>
                  <th>{t("invitations.created")}</th>
                  <th>{t("invitations.expires")}</th>
                  <th>{t("invitations.status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.invitations.map((inv) => {
                  const used = inv.used_by !== null;
                  const expired =
                    !used &&
                    inv.expires_at !== null &&
                    new Date(inv.expires_at) < new Date();
                  const status = used
                    ? t("invitations.statusUsed", inv.used_by ?? "")
                    : expired
                      ? t("invitations.statusExpired")
                      : t("invitations.statusAvailable");
                  const kind = used ? "off" : expired ? "warn" : "on";
                  return (
                    <tr key={inv.code}>
                      <td>
                        <code class={"token-value"}>{inv.code}</code>
                      </td>
                      <td>{new Date(inv.created_at).toLocaleString()}</td>
                      <td>
                        {inv.expires_at
                          ? new Date(inv.expires_at).toLocaleString()
                          : "—"}
                      </td>
                      <td>
                        <Badge text={status} kind={kind} />
                      </td>
                      <td>
                        {!used && !expired ? (
                          <Button
                            label={t("invitations.copy")}
                            title={t("invitations.copy")}
                            aria-label={t("invitations.copy")}
                            onclick={() => copyInvite(inv.code)}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}
    </Page>
  ),
};

void mountPage(() => t("profile.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
