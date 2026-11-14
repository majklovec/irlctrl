// systeminfo card: live hardware telemetry for every role. Renders as the last
// card before the log (`order: 1000`).
//
// Stateless by design (matches the other device cards): the backend pushes a
// retained `systeminfo.stats` frame on an interval, and this view renders the
// newest frame from the device store's event bag — no component-local timers
// that would fight mithril's render cycle.

import "./styles.css";
import { Card } from "@ui/components/";
import { card, type DeviceCard } from "@ui/device/store";
import { t } from "@ui/i18n";
import { formatBitrate, formatSpeed } from "@ui/util";
import m from "mithril";
import type { FrontendModule } from "../../../shared/contracts/frontend_module";
import type { Status } from "../../../shared/contracts/wire";
import type { SystemInfo } from "./types";

/** `/dev/sda1` → `sda`, `/dev/mmcblk0p2` → `mmcblk0`, `/dev/nvme0n1p3` → `nvme0n1`. */
function diskBase(device: string): string {
	return device.replace(/^\/dev\//, "").replace(/p?\d+$/, "");
}

/** Bytes → "1.2 GB" style string. */
function fmt(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = bytes;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** The newest valid `systeminfo.stats` frame, or its error text. */
function liveFrame(host: DeviceCard): {
	info?: SystemInfo;
	error?: string;
	at: number;
} {
	const entry = host.st.events.get("systeminfo.stats");
	if (!entry) return { at: 0 };
	const data = entry.data as Partial<SystemInfo> & { error?: string };
	if (!data) return { at: entry.at };
	if (data.error) return { error: data.error, at: entry.at };
	if (data.board && data.cpu && data.memory)
		return { info: data as SystemInfo, at: entry.at };
	return { at: entry.at };
}

const throttleMessages = (si: SystemInfo): string => {
	const th = si.throttling;
	if (!th) return "";
	return (
		[
			th.underVoltage && `⚡ ${t("sysinfo.undervoltage")}`,
			th.currentlyThrottled && `🔥 ${t("sysinfo.throttled")}`,
			th.armFreqCapped && `🐢 ${t("sysinfo.freq_capped")}`,
			th.softTempLimit && `🌡 ${t("sysinfo.temp_limit")}`,
		]
			.filter(Boolean)
			.join(" · ") || t("sysinfo.ok")
	);
};

function interfacesCard(host: DeviceCard, status: Status): m.Vnode {
	const { info, error, at } = liveFrame(host);
	const stale = at > 0 && Date.now() - at > 10_000;

	return (
		<Card
			title={t("sysinfo.title")}
			headActions={
				stale ? (
					<span class="muted" title={t("sysinfo.stale_title")}>
						{t("sysinfo.stale")}
					</span>
				) : undefined
			}
			class="systeminfo-card"
		>
			{!info && (
				<div class="systeminfo-empty">
					{error ? `⚠ ${error}` : t("sysinfo.loading")}
				</div>
			)}
			{info && (
				<>
					<div class="systeminfo-header">
						<strong>{info.board.model}</strong>
						<span class="systeminfo-os">
							{info.os.distro} · {info.os.kernel} · {uptimeShort(info)}
						</span>
					</div>

					<div class="systeminfo-section">
						<h4>{t("sysinfo.cpu")}</h4>
						<div>
							{info.cpu.model} · {info.cpu.cores} {t("sysinfo.cores")} ·{" "}
							{info.cpu.speedMHz} MHz
						</div>
						<div class="systeminfo-cores">
							{info.cpu.loadPerCore.map((v, i) => (
								<span key={i} class="systeminfo-core">
									<span class="systeminfo-core-id">C{i}:</span>
									<meter min={0} max={100} value={v} class="load" />
									<span class="systeminfo-core-pct">{v.toFixed(0)}%</span>
								</span>
							))}
						</div>
						<div class="systeminfo-load">
							<span>{t("sysinfo.overall_load")}</span>
							<meter
								min={0}
								max={100}
								value={info.cpu.overallLoad}
								class="load"
							/>
							{info.cpu.overallLoad.toFixed(1)}%
						</div>
					</div>

					<div class="systeminfo-section">
						<h4>{t("sysinfo.temperatures")}</h4>
						<div class="systeminfo-temps">
							{info.temperatures.length ? (
								info.temperatures.map((temp, i) => (
									<span key={i} class="systeminfo-temp">
										{temp.label ?? temp.type}: {temp.tempC.toFixed(1)}°C
									</span>
								))
							) : (
								<span class="muted">—</span>
							)}
						</div>
						{info.throttling && (
							<div
								class={`systeminfo-throttle${info.throttling.currentlyThrottled ? " warn" : ""}`}
							>
								{throttleMessages(info)}
							</div>
						)}
					</div>

					<div class="systeminfo-section">
						<h4>{t("sysinfo.memory")}</h4>
						<div class="systeminfo-load">
							<meter
								min={0}
								max={1}
								value={
									info.memory.totalBytes > 0
										? info.memory.usedBytes / info.memory.totalBytes
										: 0
								}
								class="load"
							/>
							{fmt(info.memory.usedBytes)} / {fmt(info.memory.totalBytes)}
						</div>
					</div>

					<div class="systeminfo-section">
						<h4>{t("sysinfo.disks")}</h4>
						{info.physicalDisks.length > 0 ? (
							<table class="systeminfo-table">
								<thead>
									<tr>
										<th>{t("sysinfo.disk")}</th>
										<th>{t("sysinfo.used")}</th>
										<th>{t("sysinfo.rw")}</th>
										<th>{t("sysinfo.util")}</th>
									</tr>
								</thead>
								<tbody>
									{info.physicalDisks.map((d, i) => {
										// Used = all filesystems mounted from this disk's
										// partitions, aggregated up to the disk size.
										const used = info.filesystems
											.filter((f) => diskBase(f.device) === d.name)
											.reduce((sum, f) => sum + f.usedBytes, 0);
										const pct =
											d.sizeBytes > 0
												? Math.min(100, (used / d.sizeBytes) * 100)
												: 0;
										return (
											<tr key={i}>
												<td
													title={`${d.vendor ? `${d.vendor} ` : ""}${d.model}`}
												>
													{d.name}
												</td>
												<td>
													<meter min={0} max={100} value={pct} class="load" />{" "}
													{fmt(used)} / {fmt(d.sizeBytes)}
												</td>
												<td>
													{fmt(d.readBytesPerSec)}/s · {fmt(d.writeBytesPerSec)}
													/s
												</td>
												<td>{d.ioUtilization.toFixed(1)}%</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						) : info.filesystems.length > 0 ? (
							// No /sys/block info: fall back to the plain mount list.
							<table class="systeminfo-table">
								<thead>
									<tr>
										<th>{t("sysinfo.mount")}</th>
										<th>{t("sysinfo.type")}</th>
										<th>{t("sysinfo.used")}</th>
										<th>%</th>
									</tr>
								</thead>
								<tbody>
									{info.filesystems.map((f, i) => (
										<tr key={i}>
											<td>{f.mount}</td>
											<td>{f.type}</td>
											<td>
												{fmt(f.usedBytes)} / {fmt(f.totalBytes)}
											</td>
											<td>{f.usePercent.toFixed(1)}%</td>
										</tr>
									))}
								</tbody>
							</table>
						) : null}
					</div>

					<div class="systeminfo-section">
						<h4>{t("sysinfo.network")}</h4>
						<table class="systeminfo-table">
							<thead>
								<tr>
									<th>{t("sysinfo.iface")}</th>
									<th>{t("sysinfo.ip")}</th>
									<th>{t("sysinfo.rxtx")}</th>
								</tr>
							</thead>
							<tbody>
								{info.network
									.filter((n) => !n.internal)
									.map((n, i) => (
										<tr key={i}>
											<td
												title={
													n.speedMbps !== undefined
														? formatSpeed(n.speedMbps)
														: undefined
												}
											>
												{n.iface}
											</td>
											<td>{n.ip4 ?? n.ip6 ?? "—"}</td>
											<td>
												{formatBitrate(n.rxBytesPerSec ?? 0)} ·{" "}
												{formatBitrate(n.txBytesPerSec ?? 0)}
											</td>
										</tr>
									))}
							</tbody>
						</table>
					</div>
				</>
			)}
		</Card>
	);
}

/** A short uptime string (d h m). */
function uptimeShort(info: SystemInfo): string {
	const s = info.os.uptimeSec;
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

const systeminfoModule: FrontendModule = {
	id: "systeminfo",
	kind: "device-card",
	title: "System Info",
	order: 1000, // renders LAST, just before the log section
	defaultSize: { w: 4, h: 6 },
	minSize: { w: 3, h: 4 },
	available: (status) =>
		Boolean(
			(status.systeminfo as { platformSupported?: boolean } | undefined)
				?.platformSupported,
		),
	component: (status) => interfacesCard(card, status),
};

export default systeminfoModule;
