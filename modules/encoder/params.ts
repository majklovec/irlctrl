/* `encoder.start` / `stream.start` / setup parameter parsing; unspecified fields fall back to the last used config. */
import {
    ApiError,
    oneOf,
    optionalInt,
    type Params,
    requireBoolean,
    requireString,
} from "../../shared/params";
import { data } from "./core";
import { AUDIO_CODECS, AUDIO_DEFAULT } from "./sources";
import { BITRATE_KBPS, type EncoderConfig } from "./types";

/** Min / max bitrate (kbps), defaulting to the last used values; `minFirst` sets which is validated first. */
export function parseBitrates(
    p: Params,
    minFirst = false,
): { minBitrate: number; maxBitrate: number } {
    const prev = data().encoder;
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
): EncoderConfig {
    const prev = data().encoder;
    const streamid =
        p.streamid === undefined || p.streamid === ""
            ? undefined
            : requireString(p, "streamid");
    const audioSource =
        p.audioSource === undefined || p.audioSource === ""
            ? prev?.audioSource ?? AUDIO_DEFAULT
            : requireString(p, "audioSource");
    const audioCodec = oneOf(
        p.audioCodec ?? prev?.audioCodec ?? "aac",
        "audioCodec",
        AUDIO_CODECS,
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
