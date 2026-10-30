/* Encoder-specific types and the SRTLA capability shape consumed by encoder. */
import type {
    DeviceSummary,
    Settings,
    SetupInfo,
    Status,
} from "../../shared/types";
export interface SrtlaTarget {
    listenPort: string;
    remoteHost: string;
    remotePort: string;
}

export interface SrtlaState {
    running: boolean;
    pid?: number;
    listenPort?: string;
    remoteHost?: string;
    remotePort?: string;
    startedAt?: number;
    lastReloadAt?: number;
    reloadCount?: number;
}

/** Runtime service the encoder consumes through the generic capability bus. */
export interface SrtlaCapability {
    srtlaStatus(): SrtlaState;
    startSrtla(
        listenPort: string,
        remoteHost: string,
        remotePort: string,
    ): Promise<SrtlaState>;
    stopSrtla(): Promise<void>;
    reloadSrtla(): Promise<void>;
    target(): SrtlaTarget | undefined;
}

/** One GStreamer pipeline file found under the pipelines dir. */
export interface Pipeline {
    id: string; // path relative to PIPELINES_DIR
    group: string; // first directory component ("" for top-level files)
    name: string; // file name
    asrc: boolean; // captures from an ALSA card (source can be changed / removed)
    acodec: boolean; // encodes AAC (can be switched to Opus)
    overlay: boolean; // has the bitrate text overlay
}

/** One ALSA capture card (or the "default" / "none" pseudo sources). */
export interface AudioSource {
    id: string;
    name: string;
}

/** Complete encoder start / restart configuration (`encoder.start` params; the last used one is kept in state). */
export interface EncoderConfig {
    pipeline: string;
    host: string; // SRT destination (the relay, or 127.0.0.1 when combined)
    port: string;
    minBitrate: number; // kbps
    maxBitrate: number; // kbps
    latency: number; // SRT latency, ms
    delay: number; // audio delay, ms
    streamid?: string;
    audioSource?: string; // ALSA card id, "default" or "none"
    audioCodec?: "aac" | "opus";
    bitrateOverlay?: boolean;
}

/** Live encoder process state (the status `state.encoder` slice). */
export interface EncoderState {
    running: boolean;
    pid?: number;
    config?: EncoderConfig; // last used; kept after stop so the UI can prefill
    startedAt?: number;
    restarts?: number;
    lastError?: string;
}

export type CeraBalancer = "adaptive" | "fixed" | "aimd";

/** Tuning of the adaptive (default) ceracoder balancer. */
export interface AdaptiveTuning {
    incrStep: number; // Kbps
    decrStep: number; // Kbps
    incrInterval: number; // ms
    decrInterval: number; // ms
}

/** Tuning of the AIMD ceracoder balancer. */
export interface AimdTuning {
    incrStep: number; // Kbps
    decrMult: number; // fraction of the bitrate kept on congestion (0-1)
    incrInterval: number; // ms
    decrInterval: number; // ms
}

/** ceracoder bitrate-control settings (the persisted `ceracoder` section). */
export interface CeraConfig {
    balancer: CeraBalancer;
    minBitrate: number; // Kbps
    adaptive: AdaptiveTuning;
    aimd: AimdTuning;
}

/** Bitrate bounds (kbps) shared by wire validation and the UI, single source. */
export const BITRATE_KBPS = { min: 300, max: 30_000 } as const;

/** The status envelope as the encoder card reads it (encoder fragment + the srtla state it mirrors). */
export type EncoderStatus = Status & {
    state: {
        encoder: EncoderState;
        srtla: SrtlaState;
        stream?: SrtlaTarget;
    };
    audioSources: AudioSource[];
    ceracoder: CeraConfig | null;
};

/** The first-run response with the encoder's resources. */
export type EncoderSetupInfo = SetupInfo & {
    pipelines: Pipeline[];
    audioSources: AudioSource[];
};

/** Device settings with the encoder's pipeline repositories. */
export type EncoderSettings = Settings & {
    pipelineRepositories?: string[];
};

/** The device-list row with the encoder's summary fields (plus the srtla ones its columns read). */
export type EncoderDeviceSummary = DeviceSummary & {
    encoder?: EncoderState;
    /** Configured encoder maximum (kbps), available even without SRTLA telemetry. */
    maxBitrate?: number;
    /** Live srtla_send total, bytes/s across all links (the srtla module's summary). */
    bitrate?: number;
    srtla?: SrtlaState;
    activeLinks?: number;
    totalLinks?: number;
};
