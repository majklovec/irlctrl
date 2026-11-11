/**
 * MobLink LAN relay settings: the first listen port, the interface
 * allow/ignore filters and the log level (spec 100-moblink §5.4). The relays
 * transparently bridge the shared interfaces (no destination — SRTLA lives on
 * the encoder). Start / stop live on the device card.
 */
import {
	Actions,
	Button,
	Checkbox,
	CheckField,
	Field,
	Form,
	Input,
	Options,
	Select,
} from "@ui/components/";
import { t } from "@ui/i18n";
import m from "mithril";
import type {
	ModuleContext,
	ModuleDef,
} from "../../../shared/contracts/frontend_module";
import type { ModulesView } from "../../../shared/contracts/wire";
import log from "./log";
import "./styles.css";
import type { MoblinkRelayView } from "./types";

/** Editable copy of the module's config slice (ports kept as input strings). */
const draft = {
	enabled: false,
	announceHost: "",
	listenPortBase: "5000",
	interfaceAllow: "",
	interfaceIgnore: "",
	logLevel: "info",
};

/** One regex per token (whitespace / comma separated). */
const splitList = (value: string): string[] =>
	value
		.split(/[\s,]+/)
		.map((v) => v.trim())
		.filter(Boolean);

async function save(ctx: ModuleContext): Promise<void> {
	const config: Record<string, unknown> = {
		enabled: draft.enabled,
		listenPortBase: Number(draft.listenPortBase),
		announceHost: draft.announceHost.trim(),
		interfaceAllow: splitList(draft.interfaceAllow),
		interfaceIgnore: splitList(draft.interfaceIgnore),
		logLevel: draft.logLevel,
	};
	const result = await ctx.run(() =>
		ctx.rpc.call<{ modules: ModulesView }>("modules.configure", {
			id: "moblink_relay",
			config,
		}),
	);
	ctx.setModules(result.modules);
	ctx.note(t("set.saved"));
}

const def: ModuleDef = {
	id: "moblink_relay",
	titleKey: "dev.card.moblink_relay",
	log,
	visible: (ctx) => ctx.role === "moblink_relay",
	refresh: (ctx) => {
		const v = ctx.modules["moblink_relay"] as unknown as
			| MoblinkRelayView
			| undefined;
		draft.enabled = v?.enabled ?? false;
		draft.announceHost = v?.announceHost ?? "";
		draft.listenPortBase = String(v?.listenPortBase ?? 5000);
		draft.interfaceAllow = (v?.interfaceAllow ?? []).join(" ");
		draft.interfaceIgnore = (v?.interfaceIgnore ?? []).join(" ");
		draft.logLevel = v?.logLevel ?? "info";
		m.redraw();
	},
	render: (ctx) => (
		<Form onSubmit={() => void save(ctx)}>
			<CheckField
				label={t("dev.moblink.enabled")}
				control={<Checkbox target={draft} prop="enabled" />}
			/>
			<Field
				label={t("dev.moblink.announce_host")}
				control={
					<Input
						target={draft}
						prop="announceHost"
						placeholder="auto (detected)"
					/>
				}
			/>
			<Field
				label={t("dev.moblink.local_port")}
				control={
					<Input
						target={draft}
						prop="listenPortBase"
						type="number"
						min={1}
						max={65535}
					/>
				}
			/>
			<Field
				label={t("dev.moblink.upstreams")}
				control={
					<Input
						target={draft}
						prop="interfaceAllow"
						placeholder="eth0 wlan0"
					/>
				}
			/>
			<Field
				label={t("dev.moblink.no_upstreams")}
				control={
					<Input
						target={draft}
						prop="interfaceIgnore"
						placeholder="docker0 veth.*"
					/>
				}
			/>
			<Field
				label={t("dev.moblink.loglevel")}
				control={
					<Select target={draft} prop="logLevel">
						<Options
							pairs={[
								["trace", "trace"],
								["debug", "debug"],
								["info", "info"],
								["warn", "warn"],
								["error", "error"],
							]}
						/>
					</Select>
				}
			/>
			<Actions>
				<Button type="submit" label={t("set.save")} disabled={ctx.busy} />
			</Actions>
		</Form>
	),
};

export default def;
