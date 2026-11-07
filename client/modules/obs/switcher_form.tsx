/* Low-bitrate-switcher form state for the OBS panel — pure helpers over the
 * persisted module slice: build the flat editable form from a status, coerce it
 * back to the persisted config shape, and render a switcher state badge.
 * Kept out of frontend.tsx so the panel factory stays focused on wiring. */

import { Badge } from "@ui/components/";
import { t } from "@ui/i18n";
import type { MithrilJSXComponent } from "@ui/jsx";
import m from "mithril";
import type { ObsModuleView, ObsStatus, SwitcherStatus } from "./types";

/**
 * A select's options over a live OBS name list (scenes, inputs): the names
 * themselves, plus an empty "—" entry for optional fields — no placeholder
 * defaults.
 */
export const nameOptions = (names: string[], optional = false): [string, string][] => {
	const out: [string, string][] = names.map((name): [string, string] => [
		name,
		name,
	]);
	if (optional) out.push(["", "—"]);
	return out;
};

/** Flat form over the persisted config; strings for the numeric inputs. */
export interface SwitcherForm {
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
	status.modules["obs"];

export function loadForm(status: ObsStatus): SwitcherForm {
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

export function toConfig(f: SwitcherForm): Record<string, unknown> {
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

export const StateBadge = {
	view: ({ attrs: { state } }) =>
		state === "NORMAL" ? (
			<Badge text={t("lowbs.state_normal")} kind="on" />
		) : state === "LOW" ? (
			<Badge text={t("lowbs.state_low")} kind="warn" />
		) : (
			<Badge text={t("lowbs.state_offline")} kind="off" />
		),
} as MithrilJSXComponent<{ state: SwitcherStatus["state"] }>;
