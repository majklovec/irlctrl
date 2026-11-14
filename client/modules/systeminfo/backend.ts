// systeminfo module: a read-only, board-agnostic hardware telemetry card.
//
// Serves every role (no `roles` field). The only core edge is the `core` bag;
// the actual telemetry comes from the auto-detected provider (factory.ts).
// The status fragment is nested under the `systeminfo` key so it never
// collides with fragments from other modules.

import type {
    BackendModule,
    Emit,
    Params,
} from "../../../shared/contracts/backend_module";
import { optionalInt } from "../../../shared/params";
import type { ModuleCore } from "../../backend/module_core";
import type { LinuxSystemInfoProvider } from "./base";
import { createSystemInfoProvider } from "./factory";

/** How often the live frame is sampled + pushed (`systeminfo.stats`). */
const STATS_INTERVAL_MS = 5_000;
/** The CPU/disk/network sample window inside one frame. */
const SAMPLE_MS = 1_000;

let emit: Emit | undefined;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let sampling = false;
let provider: LinuxSystemInfoProvider | null = null;
let providerError: string | null = null;

/** Sample one frame and push it (retained) so the device card stays live. */
async function pushStats(): Promise<void> {
    if (sampling || !provider) return;
    sampling = true;
    try {
        const info = await provider.getSystemInfo(SAMPLE_MS);
        const soc =
            info.temperatures.find((t) => t.type === "soc-thermal")?.tempC ??
            info.temperatures[0]?.tempC;
        emit?.("systeminfo.stats", info, {
            // Retained so a newly opened device page replays the latest frame.
            retain: true,
            summary: {
                load: info.cpu.overallLoad,
                tempC: soc,
                memoryPercent:
                    info.memory.totalBytes > 0
                        ? Math.round(
                              (1000 * info.memory.usedBytes) /
                                  info.memory.totalBytes,
                          ) / 10
                        : 0,
            },
        });
    } catch (e) {
        // A failed sample must not kill the timer; the card shows the last frame.
        emit?.("systeminfo.stats", { error: String(e) }, { retain: false });
    } finally {
        sampling = false;
    }
}

const registration: BackendModule<ModuleCore> = {
    kind: "device",
    id: "systeminfo",
    title: "System Info",
    // NO `roles` field → serves relay, encoder, obs, broadcaster.
    methods: ["systeminfo.get"],
    events: ["systeminfo.stats"],

    async start(ctx) {
        emit = ctx.emit;
        try {
            provider = await createSystemInfoProvider();
            const board = await provider.getBoardInfo();
            ctx.log("systeminfo", `Platform detected: ${board.platformName}`);
            void pushStats();
            statsTimer = setInterval(() => void pushStats(), STATS_INTERVAL_MS);
        } catch (e) {
            provider = null;
            providerError = String((e as { message?: string })?.message ?? e);
            ctx.log("systeminfo", `Provider unavailable: ${providerError}`);
        }
    },

    async stop() {
        if (statsTimer !== null) clearInterval(statsTimer);
        statsTimer = null;
    },

    async dispatch(method, params: Params) {
        if (method !== "systeminfo.get") {
            throw new Error(`unknown method ${method}`);
        }
        if (!provider) {
            throw new Error(
                providerError ??
                    "System info provider not available on this platform",
            );
        }
        const sampleMs = optionalInt(params, "sampleMs", 1000, 250, 10_000);
        return await provider.getSystemInfo(sampleMs);
    },

    async status() {
        // Lightweight fragment — the frontend card's `available()` reads
        // `status.systeminfo.platformSupported`.
        return { systeminfo: { platformSupported: provider !== null } };
    },
};

export default registration;
