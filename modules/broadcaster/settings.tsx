import m from "mithril";
import { Icon } from "../../frontend/ts/components/icons";
import {
	Actions,
	Break,
	Button,
	Field,
	FieldGroup,
	Form,
	Input,
	Options,
	Select,
} from "../../frontend/ts/components/ui";
import { t } from "../../frontend/ts/i18n";
import type { MithrilJSXComponent } from "../../frontend/ts/jsx";
import type { ModuleContext, ModuleDef } from "../../frontend/ts/modules";
import type { ModuleSliceView } from "../../shared/types";
import {
	SRTLA_CUSTOM_SERVICE,
	SRTLA_SERVICES,
	srtlaService,
	srtlaServiceForUrl,
} from "./services";

/** An ffmpeg output profile on the device. */
interface Profile {
	id: string;
	name: string;
}

/** One RTMP destination as the device reports it; the key is masked. */
interface OutputView {
	service: string;
	url: string;
	keyConfigured: boolean;
}

/** The device's broadcaster slice of the modules view; keys are masked. */
interface BroadcasterModuleView extends ModuleSliceView {
	outputs: OutputView[];
	profile: string;
	profiles: Profile[];
	profilesDir: string;
}

/**
 * Editable copy of the relay's RTMP destinations and ffmpeg output profile;
 * stream keys are write-only — the device only ever reports them as
 * {keyConfigured}.
 */
const draft = {
	outputs: [] as { service: string; url: string; key: string }[],
	profile: "copy",
};

/** The view version the draft last caught up with; unchanged pushes are
 *  no-ops so they never clobber in-progress (unsaved) edits. */
let syncSignature: string | null = null;

/**
 * Adopt the device view into the draft, in place:
 *  - The rows' identity is kept (the bound inputs keep working) while the
 *    row count and the operator's unsaved fields follow the device view; the
 *    service is re-derived (catalog id → URL inference → custom) and the URL
 *    is mirrored.
 *  - Keys are write-only — the device never echoes them, so the operator's
 *    text always wins and they are not touched.
 *  - A profile that no longer exists on the device is reset to the copy
 *    profile; an in-progress choice the device has not saved yet is kept.
 */
function adopt(view: BroadcasterModuleView | undefined): void {
	const rows = view?.outputs ?? [];
	while (draft.outputs.length > rows.length) draft.outputs.pop();
	rows.forEach((o, i) => {
		const row = draft.outputs[i] ?? { service: "", url: "", key: "" };
		row.service =
			(srtlaService(o.service) ? o.service : null) ??
			srtlaServiceForUrl(o.url) ??
			SRTLA_CUSTOM_SERVICE;
		row.url = o.url;
		if (draft.outputs[i] === undefined) draft.outputs.push(row);
	});
	if (!(view?.profiles ?? []).some((p) => p.id === draft.profile))
		draft.profile = "copy";
}

async function save(ctx: ModuleContext): Promise<void> {
	const result = await ctx.run(() =>
		ctx.rpc.call<{ modules: ModuleContext["modules"] }>("modules.configure", {
			id: "broadcaster",
			config: {
				outputs: draft.outputs,
				profile: draft.profile,
			},
		}),
	);
	ctx.setModules(result.modules);
	// Adopt the server's fresh view and mark it synced so the next status
	// push does not resync it.
	adopt(result.modules.broadcaster as BroadcasterModuleView | undefined);
	syncSignature = JSON.stringify(result.modules.broadcaster);
	// Keys are write-only: clear them from the draft, the device keeps them.
	draft.outputs = draft.outputs.map((out) => ({ ...out, key: "" }));
	ctx.note(t("set.saved"));
}

/** The ffmpeg output profile options: all profile files from the device. */
const ProfileOptions = {
	view: ({ attrs: { view } }) => {
		const profiles = view?.profiles ?? [];
		return <Options pairs={profiles.map((p) => [p.id, p.name])} />;
	},
} as MithrilJSXComponent<{ view?: BroadcasterModuleView }>;

/**
 * The per-destination service options in two groups: the common platforms,
 * then the rest (with the custom typed-URL entry last). Within a group
 * the entries are alphabetical. The group and custom labels follow the
 * current locale. A component view's bare array is rendered as a Mithril
 * fragment, so the subtree must be uniformly unkeyed (no `key` attributes)
 * — mixing keyed and unkeyed vnodes makes Mithril throw.
 */
const ServiceOptions = {
	view: () => {
		const group = (common: boolean) =>
			SRTLA_SERVICES.filter(
				(s) => s.id !== SRTLA_CUSTOM_SERVICE && s.common === common,
			)
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((s) => <option value={s.id}>{s.name}</option>);
		return [
			<optgroup label={t("set.service_group_common")}>
				{group(true)}
				<option value={SRTLA_CUSTOM_SERVICE}>{t("set.service_custom")}</option>
			</optgroup>,
			<optgroup label={t("set.service_group_other")}>{group(false)}</optgroup>,
		];
	},
} as m.Component as MithrilJSXComponent;

/** Per-destination key placeholder: configured keys show "leave blank". */
function keyPlaceholder(
	view: BroadcasterModuleView | undefined,
	index: number,
): string {
	return view?.outputs[index]?.keyConfigured
		? t("set.token_ph_configured")
		: t("set.token_ph_missing");
}

/** The inpoint (server) options for one row: the service's inpoints
 *  (bound to the URL), plus the row's current URL as a "custom" option
 *  when it matches none of them. */
const ServerOptions = {
	view: ({ attrs: { out } }) => {
		const svc = srtlaService(out.service);
		if (svc === undefined) return null;
		const pairs = svc.servers.map((s) => [s.url, s.name] as const);
		if (out.url !== "" && !svc.servers.some((s) => s.url === out.url))
			pairs.push([out.url, t("set.service_custom")] as const);
		return <Options pairs={pairs} />;
	},
} as MithrilJSXComponent<{ out: { service: string; url: string } }>;

export const def: ModuleDef = {
	id: "broadcaster",
	titleKey: "set.broadcaster",
	visible: (ctx) => ctx.role === "broadcaster",
	refresh: (ctx) => {
		// A status push while a save is in flight must not clobber the
		// operator's edits — the in-flight save already carries them.
		if (ctx.busy) return;
		const view = ctx.modules.broadcaster as BroadcasterModuleView | undefined;
		// The view lags the draft until a save round-trips, so a push that
		// carries no change since the last sync must not touch the draft —
		// the operator may be mid-edit. Set only after the sync below: a
		// push skipped while a save was in flight must not count as synced.
		const signature = JSON.stringify(view);
		if (signature === syncSignature) return;
		adopt(view);
		syncSignature = signature;
	},
	render: (ctx) => {
		const view = ctx.modules.broadcaster as BroadcasterModuleView | undefined;
		return [
			<p class="muted" key="hint">
				{t("set.broadcaster_desc")}
			</p>,
			<Form key="form" onSubmit={() => void save(ctx)}>
				<Field
					label={t("set.broadcaster_profile")}
					control={
						<Select target={draft} prop="profile">
							<ProfileOptions view={view} />
						</Select>
					}
				/>

				<FieldGroup legend={t("set.broadcaster")}>
					{draft.outputs.map((out, i) => (
						<div class="output-row" key={i}>
							<Field
								label={t("set.service")}
								control={
									<Select
										target={out}
										prop="service"
										onChange={(value) => {
											// Picking a catalog service prefills its
											// first inpoint; custom keeps the typed URL.
											const svc = srtlaService(value);
											if (svc?.servers[0]) out.url = svc.servers[0].url;
										}}
									>
										<ServiceOptions />
									</Select>
								}
							/>
							{out.service !== SRTLA_CUSTOM_SERVICE && (
								<Field
									label={t("set.server")}
									control={
										<Select target={out} prop="url">
											<ServerOptions out={out} />
										</Select>
									}
								/>
							)}
							{out.service === SRTLA_CUSTOM_SERVICE && (
								<Field
									label={t("set.rtmp_url")}
									control={
										<Input target={out} prop="url" placeholder="rtmps://…" />
									}
								/>
							)}
							<Field
								label={t("set.rtmp_key")}
								control={
									<Input
										target={out}
										prop="key"
										type="password"
										autocomplete="off"
										placeholder={keyPlaceholder(view, i)}
									/>
								}
							/>
							<Button
								label={t("set.output_remove")}
								title={t("set.output_remove")}
								disabled={ctx.busy}
								onclick={() => draft.outputs.splice(i, 1)}
							/>
						</div>
					))}
					<Button
						label={<Icon name="plus" class="role-icon" />}
						title={t("set.output_add")}
						aria-label={t("set.output_add")}
						disabled={ctx.busy}
						onclick={() =>
							draft.outputs.push({
								service: SRTLA_CUSTOM_SERVICE,
								url: "",
								key: "",
							})
						}
					/>
				</FieldGroup>

				<Break />
				<Actions>
					<Button label={t("set.save")} type="submit" disabled={ctx.busy} />
				</Actions>
			</Form>,
		];
	},
};

export default def;
