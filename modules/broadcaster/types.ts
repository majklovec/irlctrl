/*
 * Local types for the broadcaster module (never imported by the core or
 * other modules).
 */
import type { DeviceSummary, Status } from "../../shared/types";

/** The lifecycle of the srtla_rec + ffmpeg stream on the relay. */
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

/**
 * One bonded SRTLA connection's latest keepalive, parsed from `srtla_rec`'s
 * `Per-connection keepalive:` stdout lines. The receiver reports one of these
 * per SRTLA link roughly every 1–2 s while the stream is up.
 */
export interface SrtlaKeepalive {
	/** The SRTLA connection id (the `ID=` field). */
	id: number;
	/** Measured bandwidth, kbits/s (the `BW:` field). */
	bwKbits: number;
	/** Receiver window in SRTLA buffers (the `Window=` field). */
	window: number;
	/** Packets currently in flight (the `In-flight=` field). */
	inFlight: number;
	/** Round-trip time, ms (the `RTT=` field). */
	rttMs: number;
	/** NAKs reported on this connection (the `NAKs=` field). */
	naks: number;
	/** Epoch ms of the keepalive that produced these numbers. */
	at: number;
}

export interface SrtlaStreamStateFields {
	/** The stream lifecycle (`idle` / `starting` / `running` / `stopping`). */
	stream: SrtlaStreamState;
	/**
	 * Latest per-connection SRTLA keepalive stats (one entry per bonded link,
	 * sorted by connection id). Empty while the stream is not flowing.
	 */
	keepalives: SrtlaKeepalive[];
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
