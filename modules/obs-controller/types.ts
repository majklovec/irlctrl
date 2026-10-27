/*
 * Local types for the obs-controller module (never imported by the core or
 * other modules): the low-bitrate switcher's wire shapes, the module's
 * settings slice and its view of the status envelope.
 */
import type { Emit } from "../../shared/module-contract";
import type { ModuleSliceView, ModulesView, Status } from "../../shared/types";

export type { Emit };

// ----------------------------------------------------------------------
// Low-bitrate switcher wire types (sub-component of the obs-controller module)
// ----------------------------------------------------------------------

/** The switcher's state machine states — each maps to a scene. */
export type SwitcherState = "NORMAL" | "LOW" | "OFFLINE";

/**
 * One OBS SRT sample as the engine sees it (from the obs-srtla-source vendor
 * stats). A field is null when the sample does not carry it (its triggers are
 * skipped, not treated as a fault).
 */
export interface SwitcherMetrics {
	/** Recent SRT receive bitrate in kbps (byte delta over the poll interval). */
	bitrateKbps: number | null;
	/** SRT round-trip time in ms (instantaneous `msRTT`). */
	rttMs: number | null;
	/** SRT connection up (null: no sample this poll). */
	connected: boolean | null;
	/** OBS / stream is live (null: not available). */
	streaming: boolean | null;
}

/** What the switcher does when its obs-controller is disconnected. */
export type SwitcherFailBehaviour = "pause" | "ignore";

/** Thresholds: bitrate in kbps, rtt in ms. */
export interface SwitcherTriggers {
	low: number;
	offline: number;
	rtt: number;
}

/** The scenes the switcher may move between. */
export interface SwitcherScenes {
	normal: string;
	low: string;
	offline: string;
}

/** Scenes the operator manages manually; the switcher never leaves the privacy scene. */
export interface SwitcherOptionalScenes {
	starting: string;
	ending: string;
	privacy: string;
}

/**
 * The low-bitrate switcher's settings (persisted inside the
 * `settings.modules["obs-controller"]` slice, which the switcher now rides
 * on; the slice's `switcherEnabled` flag decides whether it runs). Flat on
 * purpose: the module applies it field by field and the frontend form
 * carries the defaults — there is no core-side factory or normalizer.
 */
export interface SwitcherConfig {
	/** The OBS source name whose SRTLA source exposes the SRT stats. */
	obsSourceName: string;
	failBehaviour: SwitcherFailBehaviour;
	/** Master switch for the automatic switching (the module `enabled` flag is separate). */
	autoSwitch: boolean;
	/** Ignore metrics while OBS is not streaming. */
	onlySwitchWhenStreaming: boolean;
	/** Return to the normal scene without the retry delay. */
	instantlySwitchOnRecover: boolean;
	/** Consecutive bad polls before a switch happens. */
	retryAttempts: number;
	/** Sampling period of the SRT stats poll, ms. */
	pollIntervalMs: number;
	triggers: SwitcherTriggers;
	scenes: SwitcherScenes;
	optionalScenes: SwitcherOptionalScenes;
	logToFile: boolean;
}

/**
 * The last SRT sample the switcher saw, for display on the card. A field is
 * null when the sample did not carry it (first poll: no bitrate delta yet).
 */
export interface SwitcherSrtSample {
	/** SRT connection up at the time of the sample. */
	connected: boolean;
	/** Recent SRT receive bitrate in kbps (null: not yet measurable). */
	bitrateKbps: number | null;
	/** SRT round-trip time in ms (null: not available). */
	rttMs: number | null;
}

/** The module's live state, merged into the status payload and pushed per change. */
export interface SwitcherStatus {
	/** Module started with a valid config and the SRT sample is available. */
	active: boolean;
	/** The state the engine currently acts as. */
	state: SwitcherState;
	/** What the latest poll wants (differs from `state` while retrying). */
	desiredState: SwitcherState;
	/** Consecutive bad polls toward the next switch (0 when stable). */
	retryCount: number;
	/** Last known OBS program scene (null: not sampled yet / controller down). */
	currentScene: string | null;
	/** OBS streaming flag as last reported by the controller. */
	streaming: boolean;
	/** The selected obs-controller is identified (websocket up). */
	obsConnected: boolean;
	/** The OBS source name being polled for SRT stats. */
	obsSourceName: string | null;
	/** The last SRT sample (bitrate / RTT as OBS reports); null when none yet. */
	srt: SwitcherSrtSample | null;
	/** Last successful poll (epoch ms; 0 when none). */
	updatedAt: number;
}

/** The module's slice of the modules view (secrets masked as `{configured}`). */
export interface ObsModuleView extends ModuleSliceView {
	enabled: boolean;
	obsUrl: string;
	obsPassword: string | { configured: boolean };
	sceneEvents: boolean;
	// The low-bitrate switcher rides on the obs slice; `switcherEnabled`
	// defaults to on and its settings come through untouched (no secrets).
	switcherEnabled?: boolean;
	obsSourceName?: string;
	failBehaviour?: SwitcherFailBehaviour;
	autoSwitch?: boolean;
	onlySwitchWhenStreaming?: boolean;
	instantlySwitchOnRecover?: boolean;
	retryAttempts?: number;
	pollIntervalMs?: number;
	triggers?: SwitcherTriggers;
	scenes?: SwitcherScenes;
	optionalScenes?: SwitcherOptionalScenes;
	logToFile?: boolean;
}

/** The status envelope as the obs card reads it. */
export type ObsStatus = Status & {
	/** Live state of the low-bitrate switcher (null when the module is stopped). */
	lowBitrateSwitcher?: SwitcherStatus | null;
	modules: ModulesView & { "obs-controller"?: ObsModuleView };
};

/** The module's persisted settings slice (`settings.modules["obs-controller"]`). */
export interface ObsSlice extends Partial<SwitcherConfig> {
	enabled: boolean;
	obsUrl?: string;
	obsPassword?: string;
	sceneEvents?: boolean;
	/** The low-bitrate switcher rides on this module; defaults to on. */
	switcherEnabled?: boolean;
	[key: string]: unknown;
}
