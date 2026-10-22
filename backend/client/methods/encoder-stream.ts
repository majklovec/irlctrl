import type { CeraConfig, EncoderState } from "../../../shared/types";
import {
    ApiError,
    optionalInt,
    type Params,
    requireBoolean,
    requireHost,
    requirePort,
} from "../../../shared/params";
import { state } from "../state";
import { errorMessage } from "../../../shared/util";
import { parseBitrates, parseEncoderConfig } from "./encoder-config";
import {
    manualMethods,
    moduleDispatcher,
    type MethodContext,
    type MethodMap,
    startChecked,
} from "./shared";

export function encoderStreamMethods(
    context: Pick<MethodContext, "services" | "registry" | "stream">,
): MethodMap {
    const { encoderServices, srtlaServices } = context.services;
    const moduleDispatch = moduleDispatcher(context.registry);
    const { cancelAutostart, setAutostart, startCombined, stopCombined } =
        context.stream;
    const manual = manualMethods(cancelAutostart);

    /** Combined devices: bring up srtla_send, then point belacoder at it. */
    async function startStream(p: Params) {
        const remoteHost = requireHost(p, "remoteHost");
        const remotePort = requirePort(p, "remotePort");
        const listenPort = String(
            optionalInt(
                p,
                "listenPort",
                Number(state.stream?.listenPort ?? 9000),
                1,
                65535,
            ),
        );
        const cfg = parseEncoderConfig(p, "127.0.0.1", listenPort, encoderServices);
        cancelAutostart();
        await startChecked(() =>
            startCombined({ remoteHost, remotePort, listenPort }, cfg),
        );
        return {
            srtla: srtlaServices.srtlaStatus(),
            encoder: encoderServices.encoder().status(),
        };
    }

    return {
        "encoder.status": () => ({ encoder: encoderServices.encoder().status() }),

        "encoder.start": manual(async (p) => {
            const cfg = parseEncoderConfig(
                p,
                requireHost(p, "host"),
                requirePort(p, "port"),
                encoderServices,
            );
            return {
                encoder: await startChecked(
                    () =>
                        moduleDispatch(
                            "encoder.start",
                            cfg as unknown as Record<string, unknown>,
                        ) as Promise<EncoderState>,
                ),
            };
        }),

        "encoder.stop": manual(async () => {
            await moduleDispatch("encoder.stop", {});
            return { encoder: encoderServices.encoder().status() };
        }),

        "encoder.bitrate": async (p) => {
            if (p.minBitrate === undefined && p.maxBitrate === undefined)
                throw new ApiError("maxBitrate or minBitrate is required");
            const { minBitrate, maxBitrate } = parseBitrates(p, true);
            return {
                encoder: (await moduleDispatch("encoder.bitrate", {
                    minBitrate,
                    maxBitrate,
                })) as EncoderState,
            };
        },

        "ceracoder.set": async (p) => {
            if (!encoderServices.isCera(encoderServices.encoder()))
                throw new ApiError("The device encoder is not ceracoder");
            try {
                return {
                    ceracoder: (await moduleDispatch(
                        "ceracoder.set",
                        p,
                    )) as CeraConfig,
                };
            } catch (e: unknown) {
                throw new ApiError(errorMessage(e));
            }
        },

        "stream.start": startStream,

        "stream.stop": manual(async () => {
            await stopCombined();
            return {
                srtla: srtlaServices.srtlaStatus(),
                encoder: encoderServices.encoder().status(),
            };
        }),

        "autostart.set": async (p) => {
            await setAutostart(requireBoolean(p, "enabled"));
            return { autostart: !!state.autostart };
        },
    };
}
