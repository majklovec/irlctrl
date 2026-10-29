/*
 * Local types for the broadcaster module (never imported by the core or
 * other modules).
 */
import type { DeviceSummary, Status } from "../../shared/types";

/** The lifecycle of the srtla_rec + gstreamer stream on the relay. */
export type SrtlaStreamState = "idle" | "starting" | "running" | "stopping";

/** One RTMP destination the pipeline publishes to (key masked for the UI). */
export interface SrtlaOutputState {
	/**
	 * The streaming-service catalog id (e.g. "kick", "custom") — see
	 * services.ts.
	 */
	service: string;
	/** The destination URL the ffmpeg pipeline publishes to (key not included). */
	url: string;
	/** True when a stream key is configured for this destination. */
	keyConfigured: boolean;
}

export interface SrtlaStreamStateFields {
	/** The stream lifecycle (`idle` / `starting` / `running` / `stopping`). */
	stream: SrtlaStreamState;
	/** The configured RTMP destinations (empty = setup incomplete). */
	outputs: SrtlaOutputState[];
	inputFormat: string;
	/** The selected ffmpeg output profile id (e.g. "copy", "reencode-h264"). */
	profile: string;
	/** The available output profiles (built-in + user-authored). */
	profiles: { id: string; name: string }[];
	/** Directory holding user-authored ffmpeg profile files (JSON). */
	profilesDir: string;
	srtlaPort: number;
	srtPort: number;
	metricsPort: number;
	uptimeMs: number;
	/** Consecutive auto-restarts since the stream last ran stably (0 = none). */
	restarts: number;
}

/** The status envelope as the broadcaster card reads it. */
export type BroadcasterStatus = Status & {
	/** The relay's stream slice (the `state` fragment this card renders). */
	state: SrtlaStreamStateFields;
};

/** The broadcaster's slice of the control-server device list: the stream
 * lifecycle the status `summary` advertises. */
export type BroadcasterDeviceSummary = DeviceSummary & {
	stream?: SrtlaStreamState;
};
