/*
 * Device settings — a Mithril view over the WebSocket API. Device-level
 * fields (hostname, role, color, remote connection) are saved here; each
 * module's own configuration card lives in `modules/<id>/settings.tsx` and
 * is auto-registered by the module framework from the generated manifest.
 */
import m from "mithril";
import { errorMessage } from "../../shared/util";
import { DEFAULT_COLOR, ROLES } from "../../shared/validate";
import type { ModulesView, Settings } from "../types";
import {
	Actions,
	Break,
	Button,
	Card,
	ConnectionBadge,
	Field,
	Form,
	Input,
	Options,
	Page,
	Select,
	TitleWithBack,
} from "./components/ui";
import { t } from "./i18n";
import {
	bind,
	refreshDevice,
	renderModuleCards,
	setDraftRole,
} from "./modules";
import { RpcClient, socketUrl } from "./services/rpc";
import { HOSTNAME_PATTERN, mountPage, setHeaderColor } from "./util";

const state = {
	connected: false,
	settings: null as Settings | null,
	message: "",
	saving: false,
};

/** Editable copy of the settings; the token is write-only (never sent back by the device). */
const draft = {
	hostname: "",
	role: "",
	color: DEFAULT_COLOR,
	remoteUrl: "",
	remoteToken: "",
};

const rpc = new RpcClient(() => socketUrl("../ws"));
bind(rpc);
rpc.on("open", () => {
	state.connected = true;
	state.settings = null;
	m.redraw();
	void load();
});
rpc.on("close", () => {
	state.connected = false;
	m.redraw();
});
// Live status pushes (ssh start/stop/password, srtla control, …) refresh the
// module cards so their state (e.g. the ssh `active` flag and password) never
// lags behind the device. The push carries {settings, modules, role} already.
rpc.on("status", (data) => {
	if (state.settings)
		refreshDevice({
			settings: state.settings,
			modules: (data as { modules: ModulesView }).modules,
			role: draft.role,
		});
});

/** Run an RPC call, routing its error message into `state.message`; redraws afterwards. */
async function run<T>(call: () => Promise<T>): Promise<T | undefined> {
	try {
		return await call();
	} catch (error: unknown) {
		state.message = errorMessage(error);
		return undefined;
	} finally {
		m.redraw();
	}
}

async function load(): Promise<void> {
	// Right after a (re)start the device link to the server is flapping and
	// the first fetch can time out; retry a few times before giving up.
	let result: [{ settings: Settings }, { modules: ModulesView }] | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
		result = await run(() =>
			Promise.all([
				rpc.call<{ settings: Settings }>("settings.get"),
				rpc.call<{ modules: ModulesView }>("modules.list"),
			]),
		);
		if (result) break;
	}
	if (!result) return;
	const [settings, modules] = result;
	state.settings = settings.settings;
	Object.assign(draft, {
		hostname: settings.settings.hostname,
		role: settings.settings.role,
		color: settings.settings.color,
		remoteUrl: settings.settings.remoteUrl,
	});
	refreshDevice({
		settings: settings.settings,
		modules: modules.modules,
		role: draft.role,
	});
	setHeaderColor(settings.settings.color);
}

async function save(): Promise<void> {
	state.saving = true;
	state.message = "";
	const { remoteToken, ...rest } = draft;
	const result = await run(() =>
		rpc.call<{ settings: Settings }>("settings.update", {
			...rest,
			...(remoteToken ? { remoteToken } : {}),
		}),
	);
	if (!result) {
		state.saving = false;
		return;
	}
	state.saving = false;
	draft.remoteToken = "";
	const roleChanged = result.settings.role !== state.settings?.role;
	state.message = roleChanged
		? `${t("set.saved")} ${t("set.restart_required")}`
		: t("set.saved");
	// Parameters may have changed on the device side; drop the socket so the
	// reconnect re-fetches fresh settings (hostname, role, color, …).
	rpc.reconnect();
}

function settingsCard(): m.Vnode {
	const tokenPlaceholder = !state.settings
		? t("set.token_ph_unchanged")
		: state.settings.hasRemoteToken
			? t("set.token_ph_configured")
			: t("set.token_ph_missing");
	return (
		<Card>
			<p class="muted">{t("set.description")}</p>
			<Form onSubmit={save}>
				<Field
					label={t("set.hostname")}
					control={
						<Input target={draft} prop="hostname" pattern={HOSTNAME_PATTERN} />
					}
				/>
				<Field
					label={t("set.role")}
					control={
						<Select
							target={draft}
							prop="role"
							onChange={() => setDraftRole(draft.role)}
						>
							<Options pairs={ROLES.map((r) => [r, t(`role.${r}`)] as const)} />
						</Select>
					}
				/>
				<Break />
				<Field
					label={t("set.color")}
					control={
						<Input
							target={draft}
							prop="color"
							type="color"
							onChange={setHeaderColor}
						/>
					}
				/>
				<Break />
				<Field
					label={t("set.remote_url")}
					control={
						<Input
							target={draft}
							prop="remoteUrl"
							placeholder="wss://control.example/device"
						/>
					}
				/>
				<Field
					label={t("set.remote_token")}
					control={
						<Input
							target={draft}
							prop="remoteToken"
							type="password"
							autocomplete="off"
							placeholder={tokenPlaceholder}
						/>
					}
				/>
				<Break />
				<Actions>
					<Button label={t("set.save")} type="submit" disabled={state.saving} />
				</Actions>
			</Form>
			<p class="muted" role="status">
				{state.message}
			</p>
		</Card>
	);
}

const App: m.Component = {
	view: () => (
		<Page
			title={
				<TitleWithBack href="../" backLabel={t("set.back")}>
					{t("set.title")}
				</TitleWithBack>
			}
			headerRight={<ConnectionBadge connected={state.connected} />}
		>
			{settingsCard()}
			{renderModuleCards()}
		</Page>
	),
};

void mountPage(() => t("set.title"), App);
