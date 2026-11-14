/*
 * Speedtest card: server + interface pickers, the live run view (phase,
 * speed chart, progress, cumulative Mbps), the summary and the error banner.
 *
 * State is module-owned (a device page has one card host). Live frames arrive
 * on the `speedtest.run` event; selections persist through the device
 * settings slice (`speedtest.saveSettings`), never in files. `result` frames
 * land in `SpeedtestRunEvent` order and the backend keeps the last one in
 * memory (a page reload re-fetches it via `speedtest.last`).
 */
import "./styles.css";
import { Actions, Button, Card, LineChart, Select } from "@ui/components/";
import { card, type DeviceCard } from "@ui/device/store";
import { t } from "@ui/i18n";
import m from "mithril";
import type { FrontendModule } from "../../../shared/contracts/frontend_module";
import type { Status } from "../../../shared/contracts/wire";
import { instantMbps } from "./inst_mbps";
import log from "./log";
import type {
	SpeedtestInterface,
	SpeedtestReport,
	SpeedtestRunEvent,
	SpeedtestServer,
} from "./types";

/** The live run view as the card folds it (cumulative mbps + instant samples). */
interface LiveView {
	runId: string;
	phase: "ping" | "download" | "upload" | null;
	progress: number;
	mbps: number | null;
	/** Instantaneous samples per phase for the chart (last ≤ 60 each). */
	down: number[];
	up: number[];
	/** Last cumulative frame (for the instant-mbps difference, spec §7.3). */
	cum: { mbps: number; seconds: number } | null;
}

/** The card's last result (from a `result` frame or `speedtest.last`). */
interface LastView {
	serverName: string | null;
	interface: string | null;
	serverId: number | null;
	finishedAt: string;
	report: SpeedtestReport;
	/** Per-phase instant-Mbps samples of the measured run (null for a re-fetched result). */
	chart: { down: number[]; up: number[] } | null;
}

interface UiState {
	loaded: boolean;
	servers: SpeedtestServer[];
	serversAvailable: boolean;
	interfaces: SpeedtestInterface[];
	serverId: string; // "" = Auto
	interfaceName: string; // "" = Auto
	comboOpen: boolean;
	query: string;
	live: LiveView | null;
	last: LastView | null;
	error: string | null;
}

const ui: UiState = {
	loaded: false,
	servers: [],
	serversAvailable: false,
	interfaces: [],
	serverId: "",
	interfaceName: "",
	comboOpen: false,
	query: "",
	live: null,
	last: null,
	error: null,
};

let booted = false;

/** Kick off the one-time loads (server list, interfaces, last result). */
function boot(host: DeviceCard): void {
	if (booted) return;
	booted = true;
	void host
		.act<{ available: boolean; servers: SpeedtestServer[] }>(
			null,
			"speedtest.servers",
		)
		.then((r) => {
			if (!r) return;
			ui.servers = r.servers ?? [];
			ui.serversAvailable = r.available;
			// A stored server that vanished from the list is cleared (spec §4.1).
			if (ui.serverId && !ui.servers.some((s) => String(s.id) === ui.serverId))
				ui.serverId = "";
			ui.loaded = true;
			m.redraw();
		});
	void host
		.act<{ interfaces: SpeedtestInterface[] }>(null, "speedtest.interfaces")
		.then((r) => {
			if (r) {
				ui.interfaces = r.interfaces ?? [];
				m.redraw();
			}
		});
	void host
		.act<{
			result?: SpeedtestReport;
			serverName?: string | null;
			interface?: string | null;
			serverId?: number | null;
			finishedAt?: string;
		} | null>(null, "speedtest.last")
		.then((r) => {
			if (r && r.result)
				ui.last = {
					serverName: r.serverName ?? r.result.server?.name ?? null,
					interface: r.interface ?? null,
					serverId: r.serverId ?? null,
					finishedAt: r.finishedAt ?? r.result.timestamp,
					report: r.result,
					// A re-fetched result has no live samples to chart.
					chart: null,
				};
			m.redraw();
		});
}

/** Persist a selection into the device settings slice (no module restart). */
function persist(
	host: DeviceCard,
	patch: { serverId?: string; interfaceName?: string },
): void {
	void host.act(null, "speedtest.saveSettings", {
		...(patch.serverId !== undefined
			? { serverId: patch.serverId === "" ? null : Number(patch.serverId) }
			: {}),
		...(patch.interfaceName !== undefined
			? {
					interface: patch.interfaceName === "" ? null : patch.interfaceName,
				}
			: {}),
	});
}

function startRun(host: DeviceCard): void {
	if (host.pending("speedtest.run") || ui.live) return;
	ui.error = null;
	ui.live = {
		runId: "",
		phase: "ping",
		progress: 0,
		mbps: null,
		down: [],
		up: [],
		cum: null,
	};
	m.redraw();
	void host
		.act<{ runId: string }>("speedtest.run", "speedtest.run", {
			serverId: ui.serverId === "" ? null : Number(ui.serverId),
			interface: ui.interfaceName === "" ? null : ui.interfaceName,
		})
		.then((r) => {
			if (r && ui.live) {
				ui.live.runId = r.runId;
				m.redraw();
			} else if (!r && ui.live && !ui.live.runId) {
				// The run never started (409): surface it without a stream.
				ui.live = null;
				ui.error = t("speedtest.run_failed");
				m.redraw();
			}
		});
}

function cancelRun(host: DeviceCard): void {
	if (!ui.live) return;
	void host.act(null, "speedtest.cancel", { runId: ui.live.runId });
}

function refreshServers(host: DeviceCard): void {
	ui.serversAvailable = false;
	m.redraw();
	void host
		.act<{ available: boolean; servers: SpeedtestServer[] }>(
			"speedtest.servers.refresh",
			"speedtest.servers",
			{ refresh: true },
		)
		.then((r) => {
			if (!r) return;
			ui.servers = r.servers ?? [];
			ui.serversAvailable = r.available;
			if (ui.serverId && !ui.servers.some((s) => String(s.id) === ui.serverId))
				ui.serverId = "";
			m.redraw();
		});
}

// ── event folding ──────────────────────────────────────────────

function onRunEvent(_event: string, data: unknown): void {
	const env = data as SpeedtestRunEvent | undefined;
	if (!env || !env.runId) return;
	if (ui.live && env.runId !== ui.live.runId) return; // stale frame
	switch (env.kind) {
		case "phase": {
			const phase = env.data.phase as LiveView["phase"];
			ui.live = ui.live ?? {
				runId: env.runId,
				phase: null,
				progress: 0,
				mbps: null,
				down: [],
				up: [],
				cum: null,
			};
			// Series persist across phases: upload keeps the download line
			// (fresh runs start with empty arrays in startRun).
			ui.live.phase = phase;
			ui.live.progress = 0;
			ui.live.mbps = null;
			ui.live.cum = null;
			break;
		}
		case "progress": {
			const live = ui.live ?? {
				runId: env.runId,
				phase: env.data.phase as LiveView["phase"],
				progress: 0,
				mbps: null,
				down: [],
				up: [],
				cum: null,
			};
			live.mbps = env.data.mbps;
			live.progress = env.data.progress;
			// Instantaneous throughput per phase for the chart (spec §7.3).
			if (live.phase === "download" || live.phase === "upload") {
				const series = live.phase === "upload" ? live.up : live.down;
				series.push(
					instantMbps(live.cum, {
						mbps: env.data.mbps,
						seconds: env.data.seconds,
					}),
				);
				if (series.length > 60) series.shift();
			}
			live.cum = { mbps: env.data.mbps, seconds: env.data.seconds };
			break;
		}
		case "result": {
			const report = env.data.reports[0];
			if (report)
				ui.last = {
					serverName:
						report.server?.name ??
						ui.servers.find((s) => s.id === Number(ui.serverId))?.name ??
						null,
					interface: ui.interfaceName || null,
					serverId: ui.serverId === "" ? null : Number(ui.serverId),
					finishedAt: report.timestamp,
					report,
					// Keep the measured curves visible in the summary (result
					// always precedes exit, so ui.live still holds the series).
					chart: ui.live
						? { down: [...ui.live.down], up: [...ui.live.up] }
						: null,
				};
			break;
		}
		case "error":
			ui.error = env.data.message;
			ui.live = null;
			break;
		case "exit":
			ui.live = null;
			break;
	}
	m.redraw();
}

// ── views ──────────────────────────────────────────────────────

function serverCombo(host: DeviceCard): m.Vnode {
	const sel = ui.servers.find((s) => String(s.id) === ui.serverId);
	const q = ui.query.trim().toLowerCase();
	const matches = ui.servers.filter(
		(s) =>
			!q ||
			s.name.toLowerCase().includes(q) ||
			s.sponsor.toLowerCase().includes(q),
	);
	const shown = matches.slice(0, 8);
	return (
		<div class="st-combo">
			<input
				value={
					ui.comboOpen ? ui.query : (sel?.name ?? t("speedtest.auto_server"))
				}
				placeholder={
					ui.serversAvailable
						? t("speedtest.search")
						: t("speedtest.servers_unavailable")
				}
				aria-label={t("speedtest.server")}
				disabled={!ui.serversAvailable && !ui.servers.length && !ui.loaded}
				onfocus={() => {
					ui.comboOpen = true;
					ui.query = "";
					m.redraw();
				}}
				oninput={(e: Event) => {
					ui.query = (e.target as HTMLInputElement).value;
					ui.comboOpen = true;
					m.redraw();
				}}
				class="w-full"
			/>
			{ui.comboOpen ? (
				<div class="st-combo-list">
					<button
						type="button"
						class={ui.serverId === "" ? "sel" : ""}
						onclick={() => {
							ui.serverId = "";
							ui.comboOpen = false;
							ui.query = "";
							persist(host, { serverId: "" });
							m.redraw();
						}}
					>
						{t("speedtest.auto_server")}
					</button>
					{shown.map((s) => (
						<button
							key={s.id}
							type="button"
							class={String(s.id) === ui.serverId ? "sel" : ""}
							title={s.sponsor || undefined}
							onclick={() => {
								ui.serverId = String(s.id);
								ui.comboOpen = false;
								ui.query = "";
								persist(host, { serverId: String(s.id) });
								m.redraw();
							}}
						>
							{s.name}
							{s.ping !== null ? (
								<span class="st-ping">{s.ping} ms</span>
							) : null}
						</button>
					))}
					{matches.length > shown.length ? (
						<span class="muted">…</span>
					) : matches.length === 0 ? (
						<span class="muted">{t("speedtest.servers_empty")}</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function liveView(): m.Vnode {
	const live = ui.live!;
	const phaseLabel =
		live.phase === "ping"
			? t("speedtest.phase_ping")
			: live.phase === "download"
				? t("speedtest.phase_download")
				: live.phase === "upload"
					? t("speedtest.phase_upload")
					: "";
	return (
		<div class={`st-live st-live-${live.phase ?? "wait"}`}>
			<div class="st-live-head">
				<span class="st-live-phase" aria-live="polite">
					{live.phase === "ping" ? "⏱ " : ""}
					{phaseLabel}
					{live.phase === "ping" ? "…" : ""}
				</span>
				<span class="st-live-mbps">
					{live.mbps !== null ? `${live.mbps.toFixed(2)} Mbps` : ""}
				</span>
			</div>
			{live.down.length + live.up.length >= 2
				? speedChart(live.down, live.up)
				: null}
			{live.phase !== "ping" ? (
				<div
					class="st-bar"
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(live.progress)}
				>
					<div
						class="st-bar-fill"
						style={{ width: `${Math.min(100, live.progress)}%` }}
					/>
				</div>
			) : (
				<div class="st-bar st-bar-ping">
					<div class="st-bar-spin" />
				</div>
			)}
		</div>
	);
}

/** The download + upload instant-Mbps curves (also kept in the summary). */
function speedChart(down: number[], up: number[]): m.Vnode {
	return (
		<div class="st-chart">
			<LineChart
				series={[
					{
						key: "down",
						label: t("speedtest.download"),
						points: down.map((v, i): { t: number; v: number } => ({
							t: i,
							v,
						})),
					},
					{
						key: "up",
						label: t("speedtest.upload"),
						points: up.map((v, i): { t: number; v: number } => ({
							t: i,
							v,
						})),
					},
				]}
				title={t("speedtest.title")}
				showXAxis={false}
			/>
		</div>
	);
}

function summaryView(): m.Vnode {
	const last = ui.last!;
	const r = last.report;
	const ifaceLabel = last.interface || t("speedtest.auto_iface");
	const clientBits = [r.client?.org, r.client?.ip].filter(Boolean).join(" · ");
	return (
		<div class="st-summary">
			{last.chart && last.chart.down.length + last.chart.up.length >= 2
				? speedChart(last.chart.down, last.chart.up)
				: null}
			<div class="st-nums">
				<span class="st-num st-num-down" title={t("speedtest.download")}>
					⬇ {r.download.toFixed(2)} <em>Mbps</em>
				</span>
				<span class="st-num st-num-up" title={t("speedtest.upload")}>
					⬆ {r.upload.toFixed(2)} <em>Mbps</em>
				</span>
				<span
					class="st-num"
					title={`${t("speedtest.ping")} / ${t("speedtest.jitter")}`}
				>
					{r.ping.toFixed(1)} / {r.jitter.toFixed(1)} <em>ms</em>
				</span>
			</div>
			<div class="st-meta">
				{last.serverName ? `${last.serverName}` : ""}
				{clientBits ? ` · ${clientBits}` : ""}
				{r.tls?.version ? ` · ${r.tls.version}` : ""}
			</div>
			<div class="st-muted">
				{new Date(last.finishedAt).toLocaleString()} · {t("speedtest.iface")}{" "}
				{ifaceLabel}
				{last.serverId !== null ? ` · #${last.serverId}` : " · auto"}
			</div>
		</div>
	);
}

function speedtestBody(host: DeviceCard): m.Vnode {
	const ifaceOptions: [string, string][] = [
		["", t("speedtest.auto_iface")],
		...ui.interfaces.map((i): [string, string] => [
			i.name,
			i.addresses.length ? `${i.name} (${i.addresses.join(", ")})` : i.name,
		]),
	];
	return (
		<Card title={t("speedtest.title")} class="mod-speedtest-card">
			<div class="st-form">
				<div class="st-field w-full">
					<span class="st-field-label">{t("speedtest.server")}</span>
					{serverCombo(host)}
				</div>
				<div class="st-field">
					<span class="st-field-label">{t("speedtest.interface")}</span>
					<Select
						target={ui}
						prop="interfaceName"
						onChange={(v: string) => persist(host, { interfaceName: v })}
					>
						{ifaceOptions.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</Select>
				</div>
			</div>
			<div class="st-actions">
				<Button
					label={ui.last ? t("speedtest.rerun") : t("speedtest.run")}
					disabled={!!ui.live || host.pending("speedtest.run") || !ui.loaded}
					onclick={() => startRun(host)}
				/>
				{ui.live ? (
					<Button
						label={t("speedtest.cancel")}
						class="secondary"
						onclick={() => cancelRun(host)}
					/>
				) : null}
				<Actions>
					<a
						class="st-refresh"
						href="#"
						title={t("speedtest.refresh")}
						oncreate={(v) => {
							v.dom.addEventListener("click", (e) => {
								e.preventDefault();
								refreshServers(host);
							});
						}}
					>
						⟳ {t("speedtest.refresh")}
					</a>
				</Actions>
			</div>
			{!ui.serversAvailable && ui.loaded ? (
				<div class="st-warn">{t("speedtest.servers_unavailable")}</div>
			) : null}
			{ui.live ? liveView() : null}
			{ui.error ? (
				<div class="st-error">
					<span>⚠ {ui.error}</span>
					<Button
						label={t("speedtest.retry")}
						class="secondary"
						onclick={() => startRun(host)}
					/>
				</div>
			) : null}
			{!ui.live && ui.last ? summaryView() : null}
			{!ui.live && !ui.last && !ui.error && ui.loaded ? (
				<p class="st-muted">{t("speedtest.no_result")}</p>
			) : null}
		</Card>
	);
}

/** Close the server combobox on any outside click. */
function closeCombo(e: Event): void {
	if (!ui.comboOpen) return;
	const el = e.target as HTMLElement | null;
	if (el && el.closest && el.closest(".st-combo")) return;
	ui.comboOpen = false;
	ui.query = "";
	m.redraw();
}

const speedtestCardComp = {
	view(_v: m.Vnode): m.Vnode {
		boot(card);
		return speedtestBody(card);
	},
};

const speedtestModule: FrontendModule = {
	id: "speedtest",
	kind: "device-card",
	title: "Speedtest",
	order: 30,
	log,
	defaultSize: { w: 4, h: 6 },
	minSize: { w: 3, h: 5 },
	handleEvent: (event, data) => {
		if (event === "speedtest.run") onRunEvent(event, data);
	},
	component: (_status: Status) => m(speedtestCardComp),
};

document?.addEventListener?.("click", closeCombo, true);

export default speedtestModule;
