/**
 * MobLink streamer settings (encoder side): MTU/keepalive, uplink
 * auto-registration, and the relay-facing control plane (spec 100-moblink
 * §6.4/§6.6/§6.3 + protocol.md): the WebSocket port relays connect to and
 * the optional token shared with relays. TUN names and IPs are derived from
 * the relay/interface ordinals, so there is no base address to configure.
 * Relays are learned via UDP discovery, so there is no relay endpoint to
 * configure here. A warning is shown when auto-registration is off (manual
 * mode).
 */
import {
	Actions,
	Button,
	Checkbox,
	CheckField,
	Field,
	Form,
	Input,
} from "@ui/components/";
import { t } from "@ui/i18n";
import m from "mithril";
import type { ModulesView } from "../../../shared/contracts/wire";
import type { ModuleContext, ModuleDef } from "../../frontend/modules";
import type { MoblinkStreamerView } from "./types";

/** Editable copy detached from the view (numeric fields kept as input strings). */
const draft = {
	prefixLength: "24",
	mtu: "1400",
	keepaliveIntervalMs: "5000",
	autoRegisterUplink: true,
	runtimeStatusFile: "/tmp/moblink-status.json",
	wsPort: "8190",
	announceToken: "",
	logLevel: "info",
};

async function save(ctx: ModuleContext): Promise<void> {
	const result = await ctx.run(() =>
		ctx.rpc.call<{ modules: ModulesView }>("modules.configure", {
			id: "moblink_streamer",
			config: {
				prefixLength: Number(draft.prefixLength),
				mtu: Number(draft.mtu),
				keepaliveIntervalMs: Number(draft.keepaliveIntervalMs),
				autoRegisterUplink: draft.autoRegisterUplink,
				runtimeStatusFile: draft.runtimeStatusFile,
				wsPort: Number(draft.wsPort),
				announceToken: draft.announceToken,
				logLevel: draft.logLevel,
			},
		}),
	);
	ctx.setModules(result.modules);
	ctx.note(t("set.saved"));
}

const def: ModuleDef = {
	id: "moblink_streamer",
	titleKey: "dev.card.moblink_streamer",
	visible: (ctx) => ctx.role === "encoder",
	refresh: (ctx) => {
		if (ctx.busy) return;
		// biome-ignore lint/complexity/useLiteralKeys: dynamic module-id key
		const view = ctx.modules["moblink_streamer"] as unknown as
			| MoblinkStreamerView
			| undefined;
		const c = view?.config;
		draft.prefixLength = String(c?.prefixLength ?? 24);
		draft.mtu = String(c?.mtu ?? 1400);
		draft.keepaliveIntervalMs = String(c?.keepaliveIntervalMs ?? 5000);
		draft.autoRegisterUplink = c?.autoRegisterUplink ?? true;
		draft.runtimeStatusFile =
			c?.runtimeStatusFile ?? "/tmp/moblink-status.json";
		draft.wsPort = String(c?.wsPort ?? 8190);
		draft.announceToken = c?.announceToken ?? "";
		draft.logLevel = c?.logLevel ?? "info";
	},
	render: (ctx) => {
		return (
			<Form onSubmit={() => void save(ctx)}>
				<Field
					key="prefix"
					label={t("dev.mstream.prefix")}
					control={
						<Input
							target={draft}
							prop="prefixLength"
							name="prefixLength"
							type="number"
							min={0}
							max={32}
						/>
					}
				/>
				<Field
					key="mtu"
					label={t("dev.mstream.mtu")}
					control={
						<Input
							target={draft}
							prop="mtu"
							name="mtu"
							type="number"
							min={1}
							max={65535}
						/>
					}
				/>
				<Field
					key="keepalive"
					label={t("dev.mstream.keepalive")}
					control={
						<Input
							target={draft}
							prop="keepaliveIntervalMs"
							name="keepaliveIntervalMs"
							type="number"
							min={1}
						/>
					}
				/>
				<Field
					key="wsport"
					label={t("dev.mstream.ws_port")}
					control={
						<Input
							target={draft}
							prop="wsPort"
							name="wsPort"
							type="number"
							min={1}
							max={65535}
						/>
					}
				/>
				<Field
					key="token"
					label={t("dev.mstream.announce_token")}
					control={
						<Input
							target={draft}
							prop="announceToken"
							name="announceToken"
							type="text"
							placeholder="—"
						/>
					}
				/>
				<CheckField
					key="autoup"
					label={t("dev.mstream.autoup")}
					control={
						<Checkbox
							target={draft}
							prop="autoRegisterUplink"
							name="autoRegisterUplink"
						/>
					}
				/>
				{/* Every Form child here is keyed, so the conditional must stay
                    keyed in both branches: `cond && <keyed>` leaves a keyless `false`
                    hole in the array, and a mixed fragment throws in Mithril 2.3.
                    Use a keyed empty fragment for the hidden branch. */}
				{draft.autoRegisterUplink ? (
					m.fragment({ key: "autoup-warn" }, [])
				) : (
					<p key="autoup-warn" class="muted">
						{t("dev.mstream.autoup_off_warn")}
					</p>
				)}
				<Field
					key="statusfile"
					label={t("dev.mstream.status_file")}
					control={
						<Input
							target={draft}
							prop="runtimeStatusFile"
							name="runtimeStatusFile"
							placeholder="/tmp/moblink-status.json"
						/>
					}
				/>
				<Field
					key="loglevel"
					label={t("dev.mstream.log_level")}
					control={
						<select
							name="logLevel"
							value={draft.logLevel}
							onchange={(e: Event) => {
								draft.logLevel = (e.target as HTMLSelectElement).value;
								m.redraw();
							}}
						>
							{["trace", "debug", "info", "warn", "error"].map((l) => (
								<option key={l} value={l}>
									{l}
								</option>
							))}
						</select>
					}
				/>
				<Actions key="actions">
					<Button type="submit" label={t("set.save")} disabled={ctx.busy} />
				</Actions>
			</Form>
		);
	},
};

export default def;
