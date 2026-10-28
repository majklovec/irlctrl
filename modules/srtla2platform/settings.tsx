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

/** A pipeline mid file on the device (id = path under the pipelines dir). */
interface Pipeline {
	id: string;
	group: string;
	name: string;
}

/** The device's srtla2platform slice of the modules view; the key is masked. */
interface Srtla2PlatformModuleView extends ModuleSliceView {
	rtmpUrl: string;
	rtmpKey?: { configured: boolean };
	pipeline: string;
	pipelines: Pipeline[];
	pipelinesDir: string;
}

/**
 * Editable copy of the relay's RTMP destination and GStreamer pipeline; the
 * stream key is write-only — the device only ever reports it as
 * {configured}.
 */
const draft = {
	rtmpUrl: "",
	rtmpKey: "",
	pipeline: "",
};

async function save(ctx: ModuleContext): Promise<void> {
	const { rtmpKey } = draft;
	const result = await ctx.run(() =>
		ctx.rpc.call<{ modules: ModuleContext["modules"] }>("modules.configure", {
			id: "srtla2platform",
			config: {
				rtmpUrl: draft.rtmpUrl,
				pipeline: draft.pipeline,
				...(rtmpKey ? { rtmpKey } : {}),
			},
		}),
	);
	ctx.setModules(result.modules);
	draft.rtmpKey = "";
	ctx.note(t("set.saved"));
}

/** The pipeline options, grouped by the first path segment (like the
 * encoder's pipeline picker). An empty value keeps the built-in mid for the
 * input format. */
function pipelineOptions(view: Srtla2PlatformModuleView | undefined): m.Children {
	const pipelines = view?.pipelines ?? [];
	const groups = new Map<string, Pipeline[]>();
	for (const p of pipelines)
		groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
	return [
		<option key="" value="">
			{t("set.srtla2platform_pipeline_default")}
		</option>,
		...[...groups].map(([group, list]) => {
			const opts = (
				<Options
					key={group || "ungrouped"}
					pairs={list.map((p) => [p.id, p.name])}
				/>
			);
			return group ? (
				<optgroup key={group} label={group}>
					{opts}
				</optgroup>
			) : (
				opts
			);
		}),
	];
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
		// built-in default.
		const pipeline = view?.pipeline ?? "";
		draft.pipeline =
			pipeline === "" || (view?.pipelines ?? []).some((p) => p.id === pipeline)
				? pipeline
				: "";
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
					label={t("set.srtla2platform_pipeline")}
					control={
						<Select target={draft} prop="pipeline">
							{pipelineOptions(view)}
						</Select>
					}
				/>
				{view?.pipelines.length === 0 && (
					<p class="muted" key="no-pipelines">
						{t("set.srtla2platform_no_pipelines", {
							directory: view.pipelinesDir,
						})}
					</p>
				)}
				<Break />
				<Actions>
					<Button label={t("set.save")} type="submit" disabled={ctx.busy} />
				</Actions>
			</Form>,
		];
	},
};

export default def;
