/* OBS Studio panel — live preview (polled GetSourceScreenshot), stream/record and
 * input actions, scene deck and a VU meter. All calls go through the obs.request
 * passthrough (the browser is never a direct OBS client); state arrives via
 * `obs.event` pushes (InputVolumeMeters feeds the VU meter, scene/stream/record
 * events keep the buttons honest).
 *
 * Rendered on the device page and in one stateful dashboard instance per widget.
 */
import "./styles.css";
import m from "mithril";
import {
	Actions,
	Badge,
	Break,
	Button,
	Card,
	Checkbox,
	CheckField,
	DefinitionList,
	Field,
	FieldGroup,
	Form,
	NumberField,
	Options,
	Select,
} from "../../frontend/ts/components/ui";
import { card, type DeviceCard } from "../../frontend/ts/device/store";
import { t } from "../../frontend/ts/i18n";
import type { MithrilJSXComponent } from "../../frontend/ts/jsx";
import type {
	DeviceDashboardContext,
	DeviceDashboardWidget,
	FrontendModule,
} from "../../frontend/ts/module-contracts";
import { since, uuid } from "../../frontend/ts/util";
import type { ObsModuleView, ObsStatus, SwitcherStatus } from "./types";
import { VUMeter, type VuLevels } from "./vu-meter";

const SWITCHER_NUMBER_FIELDS = [
	["lowbs.trigger_low_bitrate", "lowBitrate", 0, 1e9, "2500"],
	["lowbs.trigger_offline_bitrate", "offlineBitrate", 0, 1e9, "500"],
	["lowbs.trigger_rtt", "rtt", 0, 1e6, "300"],
	["lowbs.retry_attempts", "retryAttempts", 1, 100, "3"],
	["lowbs.poll_interval", "pollInterval", 200, 3600000, "1000"],
] as const;

const SWITCHER_SCENE_FIELDS = [
	["lowbs.scene_normal", "sceneNormal", false],
	["lowbs.scene_low", "sceneLow", false],
	["lowbs.scene_offline", "sceneOffline", false],
	["lowbs.scene_starting", "sceneStarting", true],
	["lowbs.scene_ending", "sceneEnding", true],
	["lowbs.scene_privacy", "scenePrivacy", true],
] as const;

// ----------------------------------------------------------------------
// Panel factory — one instance per render surface, own state and timers
// ----------------------------------------------------------------------
/** Successful obs-websocket v5 envelope (the shape `obs.request` answers with). */
export interface ObsRequestResult<T> {
	requestType?: string;
	requestStatus?: { result: boolean; code?: number; comment?: string };
	responseData?: T;
}

function obsRequest<T = Record<string, unknown>>(
	requestType: string,
	requestData: Record<string, unknown> = {},
): Promise<ObsRequestResult<T> | undefined> {
	return card.act(null, "obs.request", {
		requestType,
		requestId: uuid(),
		requestData,
	});
}
/** One push of a forwarded OBS event (or the synthetic disconnect drop). */
export interface ObsEvent {
	eventType?: string;
	eventData?: Record<string, unknown>;
	disconnected?: boolean;
}
export interface ObsPanelDeps {
	/** Send one obs.request through this device's connection. */
	send: <T>(
		requestType: string,
		requestData?: Record<string, unknown>,
	) => Promise<ObsRequestResult<T> | undefined>;
	/** Subscribe to `obs.event` pushes; returns an unsubscribe. */
	onEvent: (handler: (ev: ObsEvent) => void) => () => void;
	/** Mirror state to the module-owned view model. */
	mirror?: (s: ObsPanelState) => void;
	/** The surface already knows OBS is up (dashboard warm start) — skip the first ping. */
	startConnected?: () => boolean;
	/** Runs when the last render unmounts (dropped timers, unsubscribed pushes). */
	onDestroy?: () => void;
}
export interface ObsSwitcherContext {
	host: DeviceCard;
	status: ObsStatus;
	live: SwitcherStatus | null;
}
export interface ObsPanelState {
	connected: boolean;
	streaming: boolean;
	recording: boolean;
	scene: string | null;
}
/** A built panel: render its body, optionally with switcher state, and feed it pushes. */
export interface ObsPanel {
	component(switcher?: ObsSwitcherContext): m.Vnode;
	head(): m.Vnode[];
	handleEvent(event: string, data: unknown): void;
	state: ObsPanelState;
	/** Stop timers and unsubscribe; safe to call more than once. */
	destroy(): void;
}

/** Outline microphone (24×24, strokes with currentColor); muted adds a slash. */
function micIcon(muted: boolean): m.Vnode {
	return (
		<svg class="obs-mic-icon" viewBox="0 0 24 24" aria-hidden="true">
			{[
				<rect x="9" y="3" width="6" height="11" rx="3" />,
				<path d="M5 11a7 7 0 0 0 14 0" />,
				<path d="M12 18v3" />,
				<path d="M8 21h8" />,
				muted ? <path d="M4 4 20 20" /> : null,
			]}
		</svg>
	);
}

/**
 * Build the panel. `component()` renders OBS controls and the optional switcher
 * section; `head()` adds connection status; `handleEvent` feeds pushes.
 */
export function createObsPanel({
	send,
	onEvent,
	mirror,
	startConnected,
	onDestroy,
}: ObsPanelDeps): ObsPanel {
	/* Panel-local UI state. */
	const ui = {
		/** GetSceneList names; the active one is ui.scene. */
		scenes: [] as string[],
		/** All OBS inputs (GetInputList) — the options of the switcher source select. */
		inputs: [] as string[],
		/** Metering input names (seeded from GetInputList, then follows InputVolumeMeters) — one row per source. */
		vuInputs: [] as string[],
		/** Per-input mute state, for each row's mic toggle icon. */
		vuMuted: new Map<string, boolean>(),
		studio: false,
		connected: false,
		streaming: false,
		recording: false,
		scene: null as string | null,
		loaded: false,
		loading: false,
		// preview (always the preview output; falls back to the current scene)
		previewInterval: 5_000, // ms; 0 = manual only
		previewPaused: false,
		previewData: null as string | null,
		previewAt: 0,
		previewFailed: false,
		lastAttempt: 0,
		inFlight: false,
	};
	const state: ObsPanelState = {
		connected: false,
		streaming: false,
		recording: false,
		scene: null,
	};

	/** Action keys with a request in flight (disables their buttons). */
	const pending = new Set<string>();
	let switcherForm: SwitcherForm | undefined;
	let switcherLive: SwitcherStatus | null = null;
	let mounts = 0;
	let tickTimer = 0;
	let pingInFlight = false;
	let lastPing = 0;
	/** Scene list staleness: re-run loadAll() every 15 s while connected (as the switcher does). */
	let lastLoadAt = 0;
	const SCENE_REFRESH_MS = 15_000;

	/* Live levels per input; each VUMeter animates from its own entry. */
	const vuLevels = new Map<string, VuLevels>();
	const getVuLevels = (name: string): VuLevels => {
		let l = vuLevels.get(name);
		if (!l) {
			l = { channels: [] };
			vuLevels.set(name, l);
		}
		return l;
	};

	const pushState = (): void => {
		state.connected = ui.connected;
		state.streaming = ui.streaming;
		state.recording = ui.recording;
		state.scene = ui.scene;
		mirror?.(state);
	};

	const obsCall = async <T,>(
		type: string,
		data: Record<string, unknown> = {},
	): Promise<T | undefined> => {
		let res: ObsRequestResult<T> | undefined;
		try {
			res = await send<T>(type, data);
		} catch {
			return undefined; // the socket is down — the next tick will re-probe
		}
		return res?.requestStatus?.result ? res.responseData : undefined;
	};

	/** Connection probe: a GetVersion is the cheapest round-trip the module answers. */
	async function ping(): Promise<void> {
		if (pingInFlight || ui.connected) return;
		pingInFlight = true;
		const res = await obsCall<unknown>("GetVersion");
		pingInFlight = false;
		if (res !== undefined && !ui.connected) {
			ui.connected = true;
			pushState();
			m.redraw();
		}
	}

	/** Re-read every input's mute state so each row's mic icon reflects OBS. */
	async function syncAllMute(): Promise<void> {
		const names = ui.vuInputs;
		await Promise.all(
			names.map(async (name) => {
				const mute = await obsCall<{ inputMuted: boolean }>("GetInputMute", {
					inputName: name,
				});
				if (mute) ui.vuMuted.set(name, mute.inputMuted === true);
			}),
		);
		m.redraw();
	}

	/** Fetch a single input's mute state the first time it reports volume (scene switch brings new sources). */
	function ensureMute(name: string): void {
		if (ui.vuMuted.has(name)) return;
		void obsCall<{ inputMuted: boolean }>("GetInputMute", {
			inputName: name,
		}).then((mute) => {
			if (mute) {
				ui.vuMuted.set(name, mute.inputMuted === true);
				m.redraw();
			}
		});
	}

	/** Scenes, inputs, the active scene, studio mode, stream/record state and the
	 * selected input's mute state. Stream/record are seeded from the status
	 * requests — the StateChanged events only fire on a *change*, so a page load
	 * would otherwise show both outputs as stopped until the next toggle. */
	async function loadAll(): Promise<void> {
		if (ui.loading) return;
		ui.loading = true;
		lastLoadAt = Date.now();
		const [scenes, inputs, studio, scene, stream, record] = await Promise.all([
			obsCall<{ scenes: { sceneName: string }[] }>("GetSceneList"),
			obsCall<{ inputs: { inputName: string }[] }>("GetInputList"),
			obsCall<{ studioModeEnabled: boolean }>("GetStudioModeEnabled"),
			// GetCurrentProgramScene answers { currentProgramSceneName } — not { sceneName }.
			obsCall<{ currentProgramSceneName: string }>("GetCurrentProgramScene"),
			// obs-websocket v5 answers both with a boolean `outputActive`.
			obsCall<{ outputActive: boolean }>("GetStreamStatus"),
			obsCall<{ outputActive: boolean }>("GetRecordStatus"),
		]);
		if (scenes?.scenes) ui.scenes = scenes.scenes.map((s) => s.sceneName);
		// Seed the active scene so the preview scene fallback and the scene-deck
		// highlight work before the first scene-change event arrives.
		if (scene?.currentProgramSceneName)
			ui.scene = scene.currentProgramSceneName;
		if (inputs?.inputs) {
			const names = inputs.inputs.map((i) => i.inputName);
			ui.inputs = names;
			ui.vuInputs = names;
		}
		if (studio?.studioModeEnabled !== undefined)
			ui.studio = studio.studioModeEnabled;
		if (stream?.outputActive !== undefined) ui.streaming = stream.outputActive;
		if (record?.outputActive !== undefined) ui.recording = record.outputActive;
		await syncAllMute();
		ui.loading = false;
		ui.loaded = true;
		// Mirror the seeded state to the surface's view model.
		pushState();
		m.redraw();
	}

	/** Drop the panel's live state when OBS goes away. */
	function offline(): void {
		ui.connected = false;
		ui.streaming = false;
		ui.recording = false;
		ui.scene = null;
		ui.loaded = false;
		vuLevels.clear();
		ui.vuMuted.clear();
		ui.inputs = [];
		ui.vuInputs = [];
		ui.previewData = null;
		ui.previewFailed = false;
		ui.inFlight = false;
		ui.lastAttempt = 0;
		lastPing = 0; // probe again on the next tick
		pushState();
	}

	async function captureProgram(options: {
		imageFormat: "jpg" | "png";
		imageWidth: number;
		imageHeight: number;
		imageCompressionQuality: number;
	}): Promise<string | undefined> {
		const grab = async (sourceName: string) =>
			(
				await obsCall<{ imageData: string }>("GetSourceScreenshot", {
					sourceName,
					...options,
				})
			)?.imageData;

		return (await grab("Program")) || (ui.scene ? grab(ui.scene) : undefined);
	}

	/** Refresh the preview right away (also used when the source changes). */
	async function capturePreview(): Promise<void> {
		if (!ui.connected || ui.inFlight || ui.previewPaused) return;
		ui.inFlight = true;
		ui.lastAttempt = Date.now();
		m.redraw();
		try {
			// The "Program" virtual output is the canonical capture target; setups where
			// it rejects the name (code 600) fall back to the current scene, as obs.html does.
			const data = await captureProgram({
				imageFormat: "jpg",
				imageWidth: 640,
				imageHeight: 360,
				imageCompressionQuality: 60,
			});
			if (data) {
				ui.previewData = data;
				ui.previewAt = Date.now();
				ui.previewFailed = false;
			} else ui.previewFailed = true;
		} finally {
			ui.inFlight = false;
			m.redraw();
		}
	}

	/** One-shot request with the button's pending guard. */
	function press(
		key: string,
		type: string,
		data: Record<string, unknown> = {},
	): void {
		if (!ui.connected || pending.has(key)) return;
		pending.add(key);
		m.redraw();
		void obsCall(type, data).finally(() => {
			pending.delete(key);
			m.redraw();
		});
	}

	/** Get-then-set toggle (mute, studio mode) sharing one pending slot. */
	function toggle(
		key: string,
		getType: string,
		getData: Record<string, unknown>,
		read: (r: Record<string, unknown>) => boolean,
		setType: string,
		setData: (next: boolean) => Record<string, unknown>,
		apply: (next: boolean) => void,
	): void {
		if (!ui.connected || pending.has(key)) return;
		pending.add(key);
		m.redraw();
		void (async () => {
			const current = await obsCall<Record<string, unknown>>(getType, getData);
			if (!current) return; // do not guess when the read fails
			const next = !read(current);
			const res = await obsCall<unknown>(setType, setData(next));
			if (res !== undefined) apply(next);
		})().finally(() => {
			pending.delete(key);
			m.redraw();
		});
	}

	/** Stream/record action button: active styling + the pending-slot guard. */
	const ActionButton = {
		view: ({ attrs: { pendingKey, label, active, cls, run } }) => (
			<Button
				label={label}
				class={active ? `${cls} active`.trim() : `secondary`}
				disabled={!ui.connected || pending.has(pendingKey)}
				onclick={run}
			/>
		),
	} as MithrilJSXComponent<{
		pendingKey: string;
		label: string;
		active: boolean;
		cls: string;
		run: () => void;
	}>;

	/** Screenshot the program output at full size and download it. */
	async function _screenshot(): Promise<void> {
		if (!ui.connected || pending.has("obs.screenshot")) return;
		pending.add("obs.screenshot");
		m.redraw();
		try {
			const data = await captureProgram({
				imageFormat: "png",
				imageWidth: 1920,
				imageHeight: 1080,
				imageCompressionQuality: 90,
			});
			if (data) {
				const a = document.createElement("a");
				a.href = data;
				a.download = `obs-screenshot-${Date.now()}.png`;
				a.click();
			}
		} finally {
			pending.delete("obs.screenshot");
			m.redraw();
		}
	}

	/** One 500ms tick: probe, (re)load, poll the preview and repaint. */
	const tick = (): void => {
		const now = Date.now();
		if (!ui.connected && now - lastPing > 3_000) {
			lastPing = now;
			void ping();
		}
		// First load on connect, then re-read (scenes/inputs/studio/active scene)
		// every 15 s so the scene deck tracks OBS scene-list changes.
		if (
			ui.connected &&
			!ui.loading &&
			(!ui.loaded || now - lastLoadAt >= SCENE_REFRESH_MS)
		)
			void loadAll();
		if (
			ui.connected &&
			ui.loaded &&
			ui.previewInterval > 0 &&
			!ui.previewPaused &&
			!ui.inFlight &&
			now - ui.lastAttempt >= ui.previewInterval
		)
			void capturePreview();
		m.redraw();
	};

	function handleEvent(event: string, data: unknown): void {
		if (event === "lowBitrateSwitcher.state") {
			switcherLive = (data as SwitcherStatus) ?? null;
			m.redraw();
			return;
		}
		if (event !== "obs.event") return;
		const ev = data as ObsEvent;
		// Synthetic drop event from the backend (no eventType field)
		if (ev.disconnected) {
			offline();
			m.redraw();
			return;
		}
		const d = ev.eventData ?? {};
		let dirty = false; // the rAF loop feeds the VU meter itself — no redraw needed per meter event
		switch (ev.eventType) {
			case "CurrentProgramSceneChanged":
				ui.scene = (d.sceneName as string) ?? null;
				dirty = true;
				break;
			case "StreamStateChanged":
				ui.streaming = d.outputActive === true;
				dirty = true;
				break;
			case "RecordStateChanged":
				ui.recording = d.outputActive === true;
				dirty = true;
				break;
			// OBS 31+ renamed InputMute to InputMuteStateChanged — handle both.
			case "InputMute":
			case "InputMuteStateChanged":
				if (typeof d.inputName === "string") {
					const next = d.inputMuted === true;
					if (ui.vuMuted.get(d.inputName) !== next) {
						ui.vuMuted.set(d.inputName, next);
						dirty = true;
					}
				}
				break;
			case "InputVolumeMeters": {
				// obs-websocket v5 delivers a per-bus `inputLevelsMul` array — typically
				// 2D `[[L,R,M],[L,R,M]]` for the two buses; flatten to per-channel levels.
				const inputs = d.inputs as
					| Array<{
							inputName: string;
							inputLevelsMul: number[] | number[][];
					  }>
					| undefined;
				if (inputs?.length) {
					// The row list follows the sources that are actually metering: a scene
					// change swaps them, so adopt the incoming set — keep current order for
					// sources still present, append new ones in arrival order, drop the rest.
					const incoming = inputs.map((i) => i.inputName);
					const dropped = ui.vuInputs.filter((n) => !incoming.includes(n));
					const fresh = incoming.filter((n) => !ui.vuInputs.includes(n));
					if (dropped.length || fresh.length) {
						ui.vuInputs = [
							...ui.vuInputs.filter((n) => incoming.includes(n)),
							...fresh,
						];
						for (const n of dropped) vuLevels.delete(n);
						for (const n of fresh) ensureMute(n);
						dirty = true; // the row set changed — re-render the list
					}
					for (const inp of inputs) {
						// Each channel is [magnitude, peak, input-peak] (or a bare magnitude). While
						// muted obs-websocket zeroes the first two but still reports the
						// unscaled input-peak, so fall back to it to keep the meter moving.
						getVuLevels(inp.inputName).channels = (
							inp.inputLevelsMul ?? []
						).map((c) => {
							const [mag = 0, peak = mag, inPeak = 0] = Array.isArray(c)
								? c
								: [c];
							return mag === 0 && peak === 0 && inPeak > 0
								? { mag: inPeak, peak: inPeak }
								: { mag, peak };
						});
					}
				}
				// The first event after a drop is what proves the link is back up
				if (!ui.connected) {
					ui.connected = true;
					dirty = true;
				}
				break;
			}
		}
		if (dirty) {
			pushState();
			m.redraw();
		}
	}

	let unsubscribe = () => {};

	/** Card header extras: connection badge + refresh (host adds the title). */
	function head(): m.Vnode[] {
		return [
			<Badge
				text={ui.connected ? t("obs.connected") : t("obs.offline")}
				kind={ui.connected ? "on" : "off"}
			/>,
		];
	}

	function component(switcher?: ObsSwitcherContext): m.Vnode {
		const switcherEnabled =
			switcher !== undefined &&
			switcher.status.modules["obs-controller"]?.switcherEnabled !== false;
		if (switcherEnabled && switcherForm === undefined) {
			switcherForm = loadForm(switcher.status);
		}
		const f = switcherForm;
		const s =
			switcher?.live ??
			switcherLive ??
			switcher?.status.lowBitrateSwitcher ??
			null;
		const _srtMissing = !!(
			s &&
			(s.srt === null || (s.srt.bitrateKbps === null && s.srt.rttMs === null))
		);
		/* Countdown / meta text for the preview bar. */
		const meta = (): string => {
			if (!ui.connected) return t("obs.offline");
			if (ui.previewPaused) return t("obs.paused");
			if (ui.previewInterval === 0) return t("obs.manual");
			const remaining = Math.max(
				0,
				Math.ceil((ui.lastAttempt + ui.previewInterval - Date.now()) / 1000),
			);
			return t("obs.next", { seconds: remaining });
		};

		return (
			<div
				oncreate={() => {
					mounts++;
					if (mounts === 1) {
						if (startConnected?.()) ui.connected = true;
						tickTimer = window.setInterval(tick, 500);
					}
				}}
				onremove={() => {
					mounts--;
					if (mounts <= 0) {
						mounts = 0;
						destroy();
					}
				}}
			>
				{!ui.connected ? (
					<p class="muted">{t("obs.offline")}</p>
				) : !ui.loaded ? (
					<p class="muted">{t("obs.waiting")}</p>
				) : (
					[
						/* Preview */
						<div class="obs-preview-block">
							<div class="obs-preview-stage">
								{ui.previewData ? (
									<img alt={t("obs.preview")} src={ui.previewData} />
								) : (
									<div class="obs-preview-empty">
										{ui.previewFailed
											? t("obs.preview_failed")
											: t("obs.waiting")}
									</div>
								)}
							</div>
							<div class="obs-preview-bar">
								<select
									disabled={!ui.connected}
									value={String(ui.previewInterval)}
									onchange={(e: Event) =>
										(ui.previewInterval = Number(
											(e.target as HTMLSelectElement).value,
										))
									}
								>
									{[
										[5_000, "5s"],
										[10_000, "10s"],
										[30_000, "30s"],
										[0, t("obs.manual")],
									].map(([ms, label]) => (
										<option key={String(ms)} value={String(ms)}>
											{label}
										</option>
									))}
								</select>
								{ui.previewInterval > 0 && !ui.previewPaused ? (
									<span class="obs-preview-meta">{meta()}</span>
								) : null}
								<Button
									label={ui.previewPaused ? t("obs.resume") : t("obs.pause")}
									class="secondary"
									onclick={() => (ui.previewPaused = !ui.previewPaused)}
								/>
								<Button
									label={t("obs.preview_now")}
									class="secondary"
									disabled={ui.inFlight || ui.previewPaused}
									onclick={() => void capturePreview()}
								/>
							</div>
						</div>,
						/* Scenes + output actions */
						<div class="obs-deck">
							<div class="obs-deck-col">
								<h3 class="obs-section">{t("obs.scenes")}</h3>
								<div class="obs-scene-deck">
									{ui.scenes.length ? (
										ui.scenes.map((name) => (
											<Button
												key={name}
												label={name}
												class={ui.scene === name ? "active" : "secondary"}
												disabled={!ui.connected || pending.has("obs.scene")}
												onclick={() =>
													press("obs.scene", "SetCurrentProgramScene", {
														sceneName: name,
													})
												}
											/>
										))
									) : (
										<span class="muted">{t("obs.no_scenes")}</span>
									)}
								</div>
							</div>
							<div class="obs-deck-col">
								<h3 class="obs-section">{t("obs.output")}</h3>
								<div class="obs-actions">
									<ActionButton
										key="obs.stream"
										pendingKey="obs.stream"
										label={
											ui.streaming
												? t("obs.stop_stream")
												: t("obs.start_stream")
										}
										active={ui.streaming}
										cls="obs-action-stream"
										run={() =>
											press(
												"obs.stream",
												ui.streaming ? "StopStream" : "StartStream",
											)
										}
									/>
									<ActionButton
										key="obs.record"
										pendingKey="obs.record"
										label={
											ui.recording
												? t("obs.stop_record")
												: t("obs.start_record")
										}
										active={ui.recording}
										cls="obs-action-record"
										run={() =>
											press(
												"obs.record",
												ui.recording ? "StopRecord" : "StartRecord",
											)
										}
									/>
								</div>
							</div>
						</div>,
						/* Audio — one meter row per input, each with its own mic mute toggle. */
						<div class="obs-deck">
							<h3 class="obs-section">{t("obs.audio")}</h3>
							<div class="obs-audio">
								{ui.vuInputs.length ? (
									ui.vuInputs.map((name) => {
										const muted = ui.vuMuted.get(name) === true;
										const muteKey = `obs.mute.${name}`;
										return (
											<div class="obs-audio-row" key={name}>
												<Button
													label={micIcon(muted)}
													class={muted ? "obs-mic muted" : "obs-mic"}
													title={t(muted ? "obs.unmute" : "obs.mute")}
													disabled={!ui.connected || pending.has(muteKey)}
													onclick={() =>
														toggle(
															muteKey,
															"GetInputMute",
															{ inputName: name },
															(r) => r.inputMuted === true,
															"SetInputMute",
															(next) => ({
																inputName: name,
																inputMuted: next,
															}),
															(next) => {
																ui.vuMuted.set(name, next);
															},
														)
													}
												/>
												<span class="obs-audio-name" title={name}>
													{name}
												</span>
												<VUMeter levels={getVuLevels(name)} muted={muted} />
											</div>
										);
									})
								) : (
									<span class="muted">{t("obs.no_inputs")}</span>
								)}
							</div>
						</div>,
					]
				)}
				{switcherEnabled && switcher && f ? (
					<div class="mod-switcher">
						<h3 class="obs-section">{t("lowbs.title")}</h3>
						<DefinitionList
							rows={[
								[
									t("lowbs.row_state"),
									s ? (
										<StateBadge state={s.state} />
									) : (
										<span>
											<Badge
												text={t("lowbs.idle")}
												kind="off"
												label={t("lowbs.idle_hint")}
											/>
										</span>
									),
								],
								[
									t("lowbs.row_desired"),
									s ? (
										<span>
											{[
												<StateBadge state={s.desiredState} />,
												s.desiredState !== s.state && (
													<span class="muted">{` · ${t("lowbs.row_retries")} ${s.retryCount}/${f.retryAttempts}`}</span>
												),
											]}
										</span>
									) : null,
								],
								[t("lowbs.row_scene"), s?.currentScene ?? null],
								[
									t("lowbs.row_srt_bitrate"),
									s?.srt?.bitrateKbps !== null &&
									s?.srt?.bitrateKbps !== undefined
										? `${s.srt.bitrateKbps} kbps`
										: null,
								],
								[
									t("lowbs.row_srt_rtt"),
									s?.srt?.rttMs !== null && s?.srt?.rttMs !== undefined
										? `${s.srt.rttMs} ms`
										: null,
								],
								[t("lowbs.row_updated"), s ? since(s.updatedAt) : null],
							]}
						/>
						<Form
							onSubmit={async () => {
								await switcher.host.act(
									"switcher-save",
									"lowBitrateSwitcher.save",
									{
										config: toConfig(f),
									},
								);
							}}
						>
							<CheckField
								label={t("lowbs.auto_switch")}
								control={<Checkbox target={f} prop="autoSwitch" />}
							/>
							<Break />
							<Field
								label={t("lowbs.obs_source")}
								control={
									<Select target={f} prop="obsSourceName" class="lbs-select">
										<Options pairs={nameOptions(ui.inputs, true)} />
									</Select>
								}
							/>
							<FieldGroup legend={t("lowbs.group_triggers")}>
								<div class="lbs-grid">
									{SWITCHER_NUMBER_FIELDS.map(
										([label, prop, min, max, placeholder]) => (
											<NumberField
												key={prop}
												label={t(label)}
												target={f}
												prop={prop}
												min={min}
												max={max}
												placeholder={placeholder}
											/>
										),
									)}
								</div>
							</FieldGroup>
							<FieldGroup legend={t("lowbs.group_scenes")}>
								<div class="lbs-grid">
									{SWITCHER_SCENE_FIELDS.map(([label, prop, optional]) => (
										<Field
											key={prop}
											label={t(label)}
											control={
												<Select target={f} prop={prop} class="lbs-select">
													<Options pairs={nameOptions(ui.scenes, optional)} />
												</Select>
											}
										/>
									))}
								</div>
							</FieldGroup>
							<Break />
							<CheckField
								label={t("lowbs.instantly_recover")}
								control={<Checkbox target={f} prop="instantlyRecover" />}
							/>
							<CheckField
								label={t("lowbs.only_streaming")}
								control={<Checkbox target={f} prop="onlySwitchWhenStreaming" />}
							/>
							<CheckField
								label={t("lowbs.log_to_file")}
								control={<Checkbox target={f} prop="logToFile" />}
							/>
							<Break />
							<Actions>
								<Button
									label={t("ui.save")}
									type="submit"
									disabled={switcher.host.busy.has("switcher-save")}
								/>
							</Actions>
						</Form>
					</div>
				) : null}
			</div>
		);
	}

	unsubscribe = onEvent((ev) => handleEvent("obs.event", ev));

	/** Tear down timers/subscriptions without waiting for the last onremove. */
	let destroyed = false;
	function destroy(): void {
		if (destroyed) return;
		destroyed = true;
		window.clearInterval(tickTimer);
		vuLevels.clear();
		unsubscribe();
		onDestroy?.();
	}

	return { component, head, handleEvent, state, destroy };
}

/**
 * A select's options over a live OBS name list (scenes, inputs): the names
 * themselves, plus an empty "—" entry for optional fields — no placeholder
 * defaults.
 */
const nameOptions = (names: string[], optional = false): [string, string][] => {
	const out: [string, string][] = names.map((name): [string, string] => [
		name,
		name,
	]);
	if (optional) out.push(["", "—"]);
	return out;
};

/** Flat form over the persisted config; strings for the numeric inputs. */
interface SwitcherForm {
	autoSwitch: boolean;
	obsSourceName: string;
	lowBitrate: string;
	offlineBitrate: string;
	rtt: string;
	retryAttempts: string;
	pollInterval: string;
	instantlyRecover: boolean;
	onlySwitchWhenStreaming: boolean;
	sceneNormal: string;
	sceneLow: string;
	sceneOffline: string;
	sceneStarting: string;
	sceneEnding: string;
	scenePrivacy: string;
	logToFile: boolean;
}

/** The obs module's persisted slice (the defaults below apply where a field is absent). */
const slice = (status: ObsStatus): ObsModuleView | undefined =>
	status.modules["obs-controller"];

function loadForm(status: ObsStatus): SwitcherForm {
	const c = slice(status);
	return {
		autoSwitch: c?.autoSwitch ?? true,
		obsSourceName: c?.obsSourceName ?? "",
		lowBitrate: String(c?.triggers?.low ?? 500),
		offlineBitrate: String(c?.triggers?.offline ?? 400),
		rtt: String(c?.triggers?.rtt ?? 1500),
		retryAttempts: String(c?.retryAttempts ?? 5),
		pollInterval: String(c?.pollIntervalMs ?? 1000),
		instantlyRecover: c?.instantlySwitchOnRecover ?? true,
		onlySwitchWhenStreaming: c?.onlySwitchWhenStreaming ?? false,
		sceneNormal: c?.scenes?.normal ?? "",
		sceneLow: c?.scenes?.low ?? "",
		sceneOffline: c?.scenes?.offline ?? "",
		sceneStarting: c?.optionalScenes?.starting ?? "",
		sceneEnding: c?.optionalScenes?.ending ?? "",
		scenePrivacy: c?.optionalScenes?.privacy ?? "",
		logToFile: c?.logToFile ?? true,
	};
}

function toConfig(f: SwitcherForm): Record<string, unknown> {
	const num = (s: string): number => {
		const v = Number(s);
		return Number.isFinite(v) && v >= 0 ? v : 0;
	};
	return {
		obsSourceName: f.obsSourceName,
		failBehaviour: "pause",
		autoSwitch: f.autoSwitch,
		onlySwitchWhenStreaming: f.onlySwitchWhenStreaming,
		instantlySwitchOnRecover: f.instantlyRecover,
		retryAttempts: Math.max(
			1,
			Math.min(100, Math.floor(Number(f.retryAttempts) || 1)),
		),
		pollIntervalMs: Math.max(200, Math.floor(Number(f.pollInterval) || 1000)),
		triggers: {
			low: num(f.lowBitrate),
			offline: num(f.offlineBitrate),
			rtt: num(f.rtt),
		},
		scenes: {
			normal: f.sceneNormal,
			low: f.sceneLow,
			offline: f.sceneOffline,
		},
		optionalScenes: {
			starting: f.sceneStarting,
			ending: f.sceneEnding,
			privacy: f.scenePrivacy,
		},
		logToFile: f.logToFile,
	};
}

const StateBadge = {
	view: ({ attrs: { state } }) =>
		state === "NORMAL" ? (
			<Badge text={t("lowbs.state_normal")} kind="on" />
		) : state === "LOW" ? (
			<Badge text={t("lowbs.state_low")} kind="warn" />
		) : (
			<Badge text={t("lowbs.state_offline")} kind="off" />
		),
} as MithrilJSXComponent<{ state: SwitcherStatus["state"] }>;

// ----------------------------------------------------------------------
// Device page binding — the module registry renders this one instance
// ----------------------------------------------------------------------
interface DashboardPanel {
	panel: ObsPanel;
	rpc: DeviceDashboardContext["rpc"];
	switcher: SwitcherStatus | null;
}

const dashboardPanels = new Map<string, DashboardPanel>();

function dashboardPanel(context: DeviceDashboardContext): DashboardPanel {
	const { widget, rpc } = context;
	const status = context.status as ObsStatus | undefined;
	const existing = dashboardPanels.get(widget.id);
	if (existing && existing.rpc !== rpc) {
		existing.panel.destroy();
		dashboardPanels.delete(widget.id);
	}
	const current = dashboardPanels.get(widget.id);
	if (current) {
		current.switcher = status?.lowBitrateSwitcher ?? current.switcher;
		return current;
	}

	let unsubscribeSwitcher = () => {};
	let panel: ObsPanel;
	panel = createObsPanel({
		send: <T = Record<string, unknown>>(
			requestType: string,
			requestData?: Record<string, unknown>,
		) =>
			rpc.call<ObsRequestResult<T> | undefined>("obs.request", {
				requestType,
				requestId: crypto.randomUUID(),
				requestData: requestData ?? {},
			}),
		onEvent: (handler) =>
			rpc.on("obs.event", (data) => handler(data as ObsEvent)),
		mirror: () => m.redraw(),
		onDestroy: () => {
			unsubscribeSwitcher();
			if (dashboardPanels.get(widget.id)?.panel === panel)
				dashboardPanels.delete(widget.id);
		},
	});
	const entry: DashboardPanel = {
		panel,
		rpc,
		switcher: status?.lowBitrateSwitcher ?? null,
	};
	unsubscribeSwitcher = rpc.on("lowBitrateSwitcher.state", (data) => {
		entry.switcher = (data as SwitcherStatus | null) ?? null;
		m.redraw();
	});
	dashboardPanels.set(widget.id, entry);
	return entry;
}

const obsDashboardWidgets: DeviceDashboardWidget[] = [
	{
		type: "obs",
		available: (device) =>
			(device.role === "obs" || device.role === undefined) &&
			device.modules?.["obs-controller"]?.enabled === true,
		defaultSize: { w: 6, h: 13 },
		minSize: { w: 4, h: 4 },
		body(context) {
			if (!context.device.online)
				return <p class="muted">{t("dev.badge.offline")}</p>;
			if (!context.status)
				return <p class="muted">{t("dash.widget_waiting")}</p>;
			const { panel, switcher } = dashboardPanel(context);
			return panel.component({
				host: context.card,
				status: context.status as ObsStatus,
				live: switcher,
			});
		},
		badge(context) {
			if (!context.device.online || !context.rpc.open)
				return <Badge text={t("dev.badge.offline")} kind="off" />;
			if (!context.status)
				return <Badge text={t("dash.widget_waiting")} kind="warn" />;
			return dashboardPanel(context).panel.head()[0];
		},
		destroy(widgetId) {
			dashboardPanels.get(widgetId)?.panel.destroy();
		},
	},
];

const obsControllerModule: FrontendModule = (() => {
	const panel = createObsPanel({
		send: obsRequest,
		onEvent: () => () => {}, // the registry routes obs.event through handleEvent
	});

	return {
		id: "obs-controller",
		kind: "device-card",
		title: "OBS",
		order: 30,
		available: (status) => status.modules["obs-controller"]?.enabled === true,
		dashboardWidgets: obsDashboardWidgets,
		defaultSize: { w: 6, h: 13 },
		minSize: { w: 4, h: 4 },
		component: (status) => (
			<Card
				title={t("obs.card")}
				class="mod-obs-controller"
				headActions={panel.head()}
			>
				{panel.component(
					status
						? { host: card, status: status as ObsStatus, live: null }
						: undefined,
				)}
			</Card>
		),
		handleEvent: (event, data, host) => {
			if (host && host !== card) return;
			panel.handleEvent(event, data);
		},
	};
})();

export default obsControllerModule;
