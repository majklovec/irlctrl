import type { EncoderConfig } from "../../../shared/types";
import {
    ApiError,
    oneOf,
    optionalInt,
    type Params,
    requireBoolean,
    requireString,
} from "../../../shared/params";
import { state } from "../state";
import { BITRATE_KBPS } from "../../../shared/types";
import type { EncoderServices } from "../capabilities";

/** Min / max bitrate (kbps), defaulting to the last used values; `minFirst` sets which is validated first. */
export function parseBitrates(
    p: Params,
    minFirst = false,
): { minBitrate: number; maxBitrate: number } {
    const prev = state.encoder.config;
    const { min, max } = BITRATE_KBPS;
    const parseMax = () =>
        optionalInt(p, "maxBitrate", prev?.maxBitrate ?? 5000, min, max);
    const parseMin = () =>
        optionalInt(p, "minBitrate", prev?.minBitrate ?? min, min, max);
    let minBitrate: number, maxBitrate: number;
    if (minFirst) {
        minBitrate = parseMin();
        maxBitrate = parseMax();
    } else {
        maxBitrate = parseMax();
        minBitrate = parseMin();
    }
    if (minBitrate > maxBitrate)
        throw new ApiError("minBitrate must not exceed maxBitrate");
    return { minBitrate, maxBitrate };
}

export function parseEncoderConfig(
    p: Params,
    host: string,
    port: string,
    encoderServices: EncoderServices,
): EncoderConfig {
    const prev = state.encoder.config;
    const streamid =
        p.streamid === undefined || p.streamid === ""
            ? undefined
            : requireString(p, "streamid");
    const audioSource =
        p.audioSource === undefined || p.audioSource === ""
            ? prev?.audioSource ?? encoderServices.AUDIO_DEFAULT
            : requireString(p, "audioSource");
    const audioCodec = oneOf(
        p.audioCodec ?? prev?.audioCodec ?? "aac",
        "audioCodec",
        encoderServices.AUDIO_CODECS,
    );
    if (p.bitrateOverlay !== undefined) requireBoolean(p, "bitrateOverlay");
    const { minBitrate, maxBitrate } = parseBitrates(p);
    return {
        pipeline: requireString(p, "pipeline"),
        host,
        port,
        minBitrate,
        maxBitrate,
        latency: optionalInt(p, "latency", prev?.latency ?? 2000, 100, 10_000),
        delay: optionalInt(p, "delay", prev?.delay ?? 0, -2000, 2000),
        streamid,
        audioSource,
        audioCodec,
        bitrateOverlay:
            (p.bitrateOverlay as boolean | undefined) ??
            prev?.bitrateOverlay ??
            false,
    };
}
