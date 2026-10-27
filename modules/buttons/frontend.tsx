/* Buttons widget — a virtual StreamDeck on the dashboard. One widget, offered
 * once per dashboard, drives any of the user's devices: every button names a
 * device and one of its module actions (`status.actions`, the catalogue the
 * control server merges from the modules enabled there) and fires it over
 * that device's RPC. The config editor (pencil) composes the layout from the
 * catalogues of every device. */
import "./styles.css";
import m from "mithril";
import { Badge } from "../../frontend/ts/components/ui";
import { t } from "../../frontend/ts/i18n";
import type {
	DashboardWidgetModule,
	DeviceLink,
	FleetDashboardContext,
	FleetDashboardWidget,
} from "../../frontend/ts/module-contracts";
import type { DeviceSummary } from "../../shared/types";
import {
	type ButtonConfig,
	BUTTONS_DEFAULT_SIZE,
	BUTTONS_FIELD,
	BUTTONS_MAX,
	BUTTONS_MAX_SIZE,
	BUTTONS_MIN_SIZE,
	BUTTONS_WIDGET_TYPE,
	buttonDevices,
	type DashboardActionEntry,
	mergedParams,
	parseButtons,
	serializeButtons,
} from "./types";

// ------------------------------------------------------------------ live state

interface WidgetRun {
	/** Indexes of the buttons whose call is in flight. */
	inflight: Set<number>;
	error?: string;
	errorTimer?: ReturnType<typeof setTimeout>;
}
const runs = new Map<string, WidgetRun>();
const runFor = (widgetId: string): WidgetRun => {
	let run = runs.get(widgetId);
	if (!run) runs.set(widgetId, (run = { inflight: new Set() }));
	return run;
};

const ERROR_MS = 5_000;

function showError(run: WidgetRun, message: string): void {
	run.error = message;
	if (run.errorTimer) clearTimeout(run.errorTimer);
	run.errorTimer = setTimeout(() => {
		run.error = undefined;
		m.redraw();
	}, ERROR_MS);
}

/** Buttons stored in the widget config; a corrupt field renders as empty. */
function configuredButtons(config: Record<string, string> | undefined) {
	try {
		return parseButtons(config?.[BUTTONS_FIELD]);
	} catch {
		return [];
	}
}

const deviceLabel = (d: DeviceSummary | undefined, id: string) =>
	d?.hostname || d?.id || id;

/** What a configured button resolves to right now. */
interface Resolved {
	device?: DeviceSummary;
	link?: DeviceLink;
	action?: DashboardActionEntry;
	/** `ok` fires; `waiting` has no status yet; `offline`; `orphan` = the
	 * device offers no such action (module off) or is no longer the user's. */
	state: "ok" | "waiting" | "offline" | "orphan";
}

function resolve(ctx: FleetDashboardContext, b: ButtonConfig): Resolved {
	const device = ctx.devices.find((d) => d.id === b.deviceId);
	if (!device) return { state: "orphan" };
	const link = ctx.link(b.deviceId);
	const actions = link?.status?.actions;
	if (!actions)
		return { device, link, state: device.online ? "waiting" : "offline" };
	const action = actions.find((a) => a.key === b.actionId);
	if (!action) return { device, link, state: "orphan" };
	return { device, link, action, state: device.online ? "ok" : "offline" };
}

const labelOf = (r: Resolved, b: ButtonConfig) =>
	b.labelOverride || (r.action ? t(r.action.label) : b.actionId);
const iconOf = (r: Resolved, b: ButtonConfig) =>
	b.iconOverride || r.action?.icon || "";

async function press(
	ctx: FleetDashboardContext,
	index: number,
	button: ButtonConfig,
	r: Resolved,
): Promise<void> {
	const run = runFor(ctx.widget.id);
	if (run.inflight.has(index) || !r.action || !r.link) return;
	const label = labelOf(r, button);
	if (
		r.action.confirm &&
		!window.confirm(
			t("buttons.confirm", {
				label,
				device: deviceLabel(r.device, button.deviceId),
			}),
		)
	)
		return;
	run.inflight.add(index);
	m.redraw();
	try {
		await r.link.rpc.call(r.action.method, mergedParams(r.action, button));
	} catch (err) {
		showError(
			run,
			t("buttons.failed", {
				label,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	} finally {
		run.inflight.delete(index);
		m.redraw();
	}
}

const stateTitle = (r: Resolved): string => {
	if (r.state === "ok") return r.action?.method ?? "";
	if (r.state === "waiting") return t("buttons.waiting");
	if (r.state === "offline") return t("dev.badge.offline");
	return t("buttons.unavailable");
};

/** The button grid; `live` wires the presses (the editor preview is inert). */
function grid(
	ctx: FleetDashboardContext,
	buttons: readonly ButtonConfig[],
	live: boolean,
): m.Children {
	const run = runFor(ctx.widget.id);
	return (
		<div class="buttons-grid">
			{buttons.map((b, i) => {
				const r = resolve(ctx, b);
				const busy = run.inflight.has(i);
				const icon = iconOf(r, b);
				return (
					<button
						type="button"
						key={`${i}:${b.deviceId}:${b.actionId}`}
						class={[
							"buttons-key",
							r.state === "orphan" ? "is-orphan" : undefined,
							busy ? "is-busy" : undefined,
							r.action?.confirm ? "is-confirm" : undefined,
						]
							.filter(Boolean)
							.join(" ")}
						disabled={!live || r.state !== "ok" || busy}
						title={stateTitle(r)}
						onclick={() => {
							if (live) void press(ctx, i, b, r);
						}}
					>
						{busy ? (
							<span class="buttons-spinner" aria-hidden="true" />
						) : icon ? (
							<span class="buttons-icon" aria-hidden="true">
								{icon}
							</span>
						) : null}
						<span class="buttons-label">{labelOf(r, b)}</span>
						<span class="buttons-device">
							{deviceLabel(r.device, b.deviceId)}
						</span>
					</button>
				);
			})}
		</div>
	);
}

function body(ctx: FleetDashboardContext): m.Children {
	const buttons = configuredButtons(ctx.widget.config);
	const run = runFor(ctx.widget.id);
	if (buttons.length === 0)
		return <p class="muted buttons-empty">{t("buttons.empty")}</p>;
	return (
		<div class="buttons-widget">
			{grid(ctx, buttons, true)}
			{run.error ? (
				<div class="buttons-toast" role="alert">
					{run.error}
				</div>
			) : null}
		</div>
	);
}

/** Devices online / referenced — the shell shows it next to the title. */
function badge(ctx: FleetDashboardContext): m.Children {
	const ids = buttonDevices(configuredButtons(ctx.widget.config));
	if (ids.length === 0) return null;
	const online = ids.filter(
		(id) => ctx.devices.find((d) => d.id === id)?.online,
	).length;
	return (
		<Badge
			text={
				ids.length === 1
					? t(online ? "dev.badge.online" : "dev.badge.offline")
					: t("buttons.badge_online", { online, total: ids.length })
			}
			kind={online === ids.length ? "on" : online ? "warn" : "off"}
		/>
	);
}

// --------------------------------------------------------------- config editor

interface EditorButton extends ButtonConfig {
	/** The params override as typed (kept verbatim until it parses). */
	paramsText: string;
}
interface EditorState {
	buttons: EditorButton[];
}
// One editor state per edit session: the dashboard shell hands the same
// `values` object to every redraw of one session and a fresh one per session.
const editors = new WeakMap<Record<string, string>, EditorState>();

function editorFor(values: Record<string, string>): EditorState {
	let state = editors.get(values);
	if (!state) {
		let buttons: ButtonConfig[] = [];
		try {
			buttons = parseButtons(values[BUTTONS_FIELD]);
		} catch {
			// unparsable stored layout — start over
		}
		state = {
			buttons: buttons.map((b) => ({
				...b,
				paramsText: b.paramsOverride
					? JSON.stringify(b.paramsOverride, null, 1)
					: "",
			})),
		};
		editors.set(values, state);
	}
	return state;
}

/** The params override a row's text parses to, or an error (undefined = none). */
function parseParamsText(
	text: string,
): { params?: Record<string, unknown>; error?: true } {
	if (text.trim() === "") return {};
	try {
		const v: unknown = JSON.parse(text);
		if (typeof v !== "object" || v === null || Array.isArray(v))
			return { error: true };
		return { params: v as Record<string, unknown> };
	} catch {
		return { error: true };
	}
}

/** Write the editor rows back into the config field (invalid params are left out until fixed). */
function commit(values: Record<string, string>, state: EditorState): void {
	values[BUTTONS_FIELD] = serializeButtons(
		state.buttons.map(({ paramsText, ...b }) => {
			const out: ButtonConfig = { deviceId: b.deviceId, actionId: b.actionId };
			if (b.labelOverride) out.labelOverride = b.labelOverride;
			if (b.iconOverride) out.iconOverride = b.iconOverride;
			const { params } = parseParamsText(paramsText);
			if (params) out.paramsOverride = params;
			return out;
		}),
	);
}

function configError(
	ctx: FleetDashboardContext,
	values: Record<string, string>,
): string | undefined {
	const state = editorFor(values);
	if (state.buttons.some((b) => resolve(ctx, b).state === "orphan"))
		return t("buttons.orphan_blocks_save");
	const bad = state.buttons.findIndex((b) => parseParamsText(b.paramsText).error);
	if (bad >= 0) return t("buttons.params_invalid", { index: bad + 1 });
	return undefined;
}

/** One device's catalogue, grouped by module, as "+ add" chips. */
function catalogueFor(
	ctx: FleetDashboardContext,
	device: DeviceSummary,
	state: EditorState,
	update: () => void,
): m.Children {
	// The editor needs every device's catalogue, not just the ones already
	// on the layout: open the link on demand (pruned when the editor closes).
	const actions = ctx.connect(device.id)?.status?.actions;
	if (!actions)
		return (
			<p class="muted buttons-catalogue-note">
				{t(device.online ? "buttons.waiting" : "dev.badge.offline")}
			</p>
		);
	if (actions.length === 0)
		return <p class="muted buttons-catalogue-note">{t("buttons.none_available")}</p>;
	const byModule = new Map<string, DashboardActionEntry[]>();
	for (const a of actions) {
		const list = byModule.get(a.moduleTitle) ?? [];
		list.push(a);
		byModule.set(a.moduleTitle, list);
	}
	return [...byModule.entries()].map(([title, list]) => (
		<div class="buttons-catalogue-group" key={title}>
			<span class="buttons-catalogue-module">{title}</span>
			<div class="buttons-catalogue-actions">
				{list.map((a) => (
					<button
						type="button"
						key={a.key}
						class="secondary buttons-catalogue-action"
						title={a.method}
						disabled={state.buttons.length >= BUTTONS_MAX}
						onclick={() => {
							state.buttons.push({
								deviceId: device.id,
								actionId: a.key,
								paramsText: "",
							});
							update();
						}}
					>
						{a.icon ? <span class="buttons-icon">{a.icon}</span> : null}
						{t(a.label)}
						<span class="buttons-add">+</span>
					</button>
				))}
			</div>
		</div>
	));
}

function configEditor(
	ctx: FleetDashboardContext,
	values: Record<string, string>,
): m.Children {
	const state = editorFor(values);
	const update = () => {
		commit(values, state);
		m.redraw();
	};
	const move = (i: number, by: number) => {
		const j = i + by;
		if (j < 0 || j >= state.buttons.length) return;
		const [row] = state.buttons.splice(i, 1);
		state.buttons.splice(j, 0, row);
		update();
	};
	const devices = [...ctx.devices].sort(
		(a, b) => Number(b.online) - Number(a.online),
	);
	const previewCtx: FleetDashboardContext = {
		...ctx,
		widget: {
			...ctx.widget,
			config: { [BUTTONS_FIELD]: values[BUTTONS_FIELD] ?? "" },
		},
	};
	return (
		<div class="buttons-editor">
			<section class="buttons-editor-section">
				<h4>{t("buttons.catalogue")}</h4>
				{devices.length === 0 ? (
					<p class="muted">{t("buttons.no_devices")}</p>
				) : (
					devices.map((device) => (
						<div class="buttons-catalogue-device" key={device.id}>
							<span class="buttons-catalogue-device-name">
								{deviceLabel(device, device.id)}
								<Badge
									text={t(device.online ? "dev.badge.online" : "dev.badge.offline")}
									kind={device.online ? "on" : "off"}
								/>
							</span>
							{catalogueFor(ctx, device, state, update)}
						</div>
					))
				)}
			</section>
			<section class="buttons-editor-section">
				<h4>{t("buttons.configured")}</h4>
				{state.buttons.length === 0 ? (
					<p class="muted">{t("buttons.empty")}</p>
				) : (
					<ol class="buttons-rows">
						{state.buttons.map((b, i) => {
							const r = resolve(ctx, b);
							const paramsBad = !!parseParamsText(b.paramsText).error;
							return (
								<li
									key={`${i}:${b.deviceId}:${b.actionId}`}
									class={[
										"buttons-row",
										r.state === "orphan" ? "is-orphan" : undefined,
									]
										.filter(Boolean)
										.join(" ")}
								>
									<div class="buttons-row-head">
										<span class="buttons-row-title">
											{iconOf(r, b) ? (
												<span class="buttons-icon">{iconOf(r, b)}</span>
											) : null}
											<span>
												{r.action ? t(r.action.label) : b.actionId}{" "}
												<span class="muted">
													· {r.action?.moduleTitle ?? ""}
													{r.action ? " @ " : "@ "}
													{deviceLabel(r.device, b.deviceId)}
												</span>{" "}
												{r.state === "orphan" ? (
													<span class="buttons-orphan-tag">
														{t("buttons.unavailable")}
													</span>
												) : null}
											</span>
										</span>
										<span class="buttons-row-actions">
											<button
												type="button"
												class="icon-btn"
												title={t("buttons.move_up")}
												aria-label={t("buttons.move_up")}
												disabled={i === 0}
												onclick={() => move(i, -1)}
											>
												↑
											</button>
											<button
												type="button"
												class="icon-btn"
												title={t("buttons.move_down")}
												aria-label={t("buttons.move_down")}
												disabled={i === state.buttons.length - 1}
												onclick={() => move(i, 1)}
											>
												↓
											</button>
											<button
												type="button"
												class="icon-btn"
												title={t("buttons.remove")}
												aria-label={t("buttons.remove")}
												onclick={() => {
													state.buttons.splice(i, 1);
													update();
												}}
											>
												×
											</button>
										</span>
									</div>
									<div class="buttons-row-fields">
										<label>
											<span>{t("buttons.label_override")}</span>
											<input
												class="dash-config-input"
												value={b.labelOverride ?? ""}
												placeholder={r.action ? t(r.action.label) : ""}
												oninput={(e: Event) => {
													b.labelOverride = (e.target as HTMLInputElement).value;
													update();
												}}
											/>
										</label>
										<label class="buttons-field-icon">
											<span>{t("buttons.icon_override")}</span>
											<input
												class="dash-config-input"
												value={b.iconOverride ?? ""}
												placeholder={r.action?.icon ?? ""}
												maxlength={4}
												oninput={(e: Event) => {
													b.iconOverride = (e.target as HTMLInputElement).value;
													update();
												}}
											/>
										</label>
										<label class="buttons-field-params">
											<span>{t("buttons.params_override")}</span>
											<textarea
												class={[
													"dash-config-input",
													paramsBad ? "is-invalid" : undefined,
												]
													.filter(Boolean)
													.join(" ")}
												rows={2}
												value={b.paramsText}
												placeholder={
													r.action?.params ? JSON.stringify(r.action.params) : "{}"
												}
												oninput={(e: Event) => {
													b.paramsText = (e.target as HTMLTextAreaElement).value;
													update();
												}}
											/>
										</label>
									</div>
								</li>
							);
						})}
					</ol>
				)}
			</section>
			{state.buttons.length > 0 ? (
				<section class="buttons-editor-section">
					<h4>{t("buttons.preview")}</h4>
					{grid(previewCtx, configuredButtons(previewCtx.widget.config), false)}
				</section>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------- registration

const buttonsWidget: FleetDashboardWidget = {
	type: BUTTONS_WIDGET_TYPE,
	defaultSize: BUTTONS_DEFAULT_SIZE,
	minSize: BUTTONS_MIN_SIZE,
	maxSize: BUTTONS_MAX_SIZE,
	configFields: [{ name: BUTTONS_FIELD, type: "hidden" }],
	devicesFor: (widget) => buttonDevices(configuredButtons(widget.config)),
	body,
	badge,
	configEditor,
	configError,
	destroy(widgetId) {
		const run = runs.get(widgetId);
		if (run?.errorTimer) clearTimeout(run.errorTimer);
		runs.delete(widgetId);
	},
};

const buttonsModule: DashboardWidgetModule = {
	kind: "dashboard",
	id: "buttons",
	fleetWidgets: [buttonsWidget],
};

export default buttonsModule;
