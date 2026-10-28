/*
 * Local types for the srtla2platform module (never imported by the core or
 * other modules).
 */
import type { Status } from "../../shared/types";

/** The lifecycle of the srtla_rec + gstreamer stream on the relay. */
export type SrtlaStreamState = "idle" | "starting" | "running" | "stopping";

export interface SrtlaStreamStateFields {
	/** The stream lifecycle (`idle` / `starting` / `running` / `stopping`). */
	stream: SrtlaStreamState;
	/** The RTMP destination URL the ffmpeg pipeline publishes to (key not included, null when unset). */
	rtmp: string | null;
	/** The stream key appended to the destination, masked (null when unset). */
	rtmpKey: string | null;
	inputFormat: string;
	/** The selected ffmpeg output profile id (e.g. "copy", "reencode-h264"). */
	profile: string;
	srtlaPort: number;
	srtPort: number;
	metricsPort: number;
	uptimeMs: number;
	/** Consecutive auto-restarts since the stream last ran stably (0 = none). */
	restarts: number;
}

/** The status envelope as the srtla2platform card reads it. */
export type Srtla2PlatformStatus = Status & {
	/** The relay's stream slice (the `state` fragment this card renders). */
	state: SrtlaStreamStateFields;
};
