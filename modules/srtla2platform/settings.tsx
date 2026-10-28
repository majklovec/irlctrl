// biome-ignore lint/correctness/noUnusedImports: the JSX factory (tsconfig jsxFactory "m")
import m from "mithril";
import {
	Actions,
	Break,
	Button,
	Field,
	Form,
	Input,
	Options,
	Select,
} from "../../frontend/ts/components/ui";
import { t } from "../../frontend/ts/i18n";
import type { ModuleContext, ModuleDef } from "../../frontend/ts/modules";
import type { ModuleSliceView } from "../../shared/types";

/** An ffmpeg output profile on the device. */
interface Profile {
	id: string;
	name: string;
}

/** The device's srtla2platform slice of the modules view; the key is masked. */
interface Srtla2PlatformModuleView extends ModuleSliceView {
	rtmpUrl: string;
	rtmpKey?: { configured: boolean };
	profile: string;
	profiles: Profile[];
	profilesDir: string;
}

/**
 * Editable copy of the relay's RTMP destination and ffmpeg output profile;
 * the stream key is write-only — the device only ever reports it as
 * {configured}.
 */
const draft = {
	rtmpUrl: "",
	rtmpKey: "",
	profile: "copy",
};

async function save(ctx: ModuleContext): Promise<void> {
	const { rtmpKey } = draft;
	const result = await ctx.run(() =>
		ctx.rpc.call<{ modules: ModuleContext["modules"] }>("modules.configure", {
			id: "srtla2platform",
			config: {
				rtmpUrl: draft.rtmpUrl,
				profile: draft.profile,
				...(rtmpKey ? { rtmpKey } : {}),
			},
		}),
	);
	ctx.setModules(result.modules);
	draft.rtmpKey = "";
	ctx.note(t("set.saved"));
}

/** The ffmpeg output profile options: all profile files from the device. */
function profileOptions(view: Srtla2PlatformModuleView | undefined): m.Children {
	const profiles = view?.profiles ?? [];
	return <Options pairs={profiles.map((p) => [p.id, p.name])} />;
}

export const def: ModuleDef = {
	id: "srtla2platform",
	titleKey: "set.srtla2platform",
	visible: (ctx) => ctx.role === "srtla2platform",
	refresh: (ctx) => {
		// A status push while a save is in flight must not clobber the user's
		// edits — the in-flight save already carries them.
		if (ctx.busy) return;
		const view = ctx.modules.srtla2platform as
			| Srtla2PlatformModuleView
			| undefined;
		draft.rtmpUrl = view?.rtmpUrl ?? "";
		draft.rtmpKey = "";
		// A selection that no longer exists on the device is reset to the
		// copy profile.
		const profile = view?.profile ?? "copy";
		draft.profile = (view?.profiles ?? []).some((p) => p.id === profile)
			? profile
			: "copy";
	},
	render: (ctx) => {
		const view = ctx.modules.srtla2platform as
			| Srtla2PlatformModuleView
			| undefined;
		const keyPlaceholder =
			view?.rtmpKey?.configured === true
				? t("set.token_ph_configured")
				: t("set.token_ph_missing");
		return [
			<p class="muted" key="hint">
				{t("set.srtla2platform_desc")}
			</p>,
			<Form key="form" onSubmit={() => void save(ctx)}>
				<Field
					label={t("set.rtmp_url")}
					control={
						<Input target={draft} prop="rtmpUrl" placeholder="rtmps://…" />
					}
				/>
				<Field
					label={t("set.rtmp_key")}
					control={
						<Input
							target={draft}
							prop="rtmpKey"
							type="password"
							autocomplete="off"
							placeholder={keyPlaceholder}
						/>
					}
				/>
				<Field
					label={t("set.srtla2platform_profile")}
					control={
						<Select target={draft} prop="profile">
							{profileOptions(view)}
						</Select>
					}
				/>
				<Break />
				<Actions>
					<Button label={t("set.save")} type="submit" disabled={ctx.busy} />
				</Actions>
			</Form>,
		];
	},
};

export default def;
