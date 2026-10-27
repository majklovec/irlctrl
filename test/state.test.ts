import { describe, expect, test } from "bun:test";
import { defaultModules, ensureModuleSlices } from "../backend/client/modules";
import { fromConfig, state } from "../backend/client/state";
import type { SwitcherConfig } from "../modules/obs-controller/types";

/**
 * The switcher rides on the OBS module slice; the module's `configDefaults`
 * complete every stored slice (`ensureModuleSlices`), so the obs slice must
 * always end up with a complete switcher set.
 */
const OBS = "obs-controller";

/** The switcher fields as they live on the obs module slice (plus the obs
 * url, to prove the non-switcher obs fields survive the backfill). */
type ObsSwitcherFields = SwitcherConfig & {
    switcherEnabled?: boolean;
    obsUrl?: string;
};

function expectCompleteObsSwitcher(
    label: string,
    obs: ObsSwitcherFields,
): void {
    expect(typeof obs.obsSourceName, `${label}: obsSourceName`).toBe("string");
    expect(typeof obs.failBehaviour, `${label}: failBehaviour`).toBe("string");
    expect(obs.triggers, `${label}: triggers`).toBeDefined();
    expect(typeof obs.triggers?.low, `${label}: triggers.low`).toBe("number");
    expect(obs.scenes, `${label}: scenes`).toBeDefined();
    expect(obs.optionalScenes, `${label}: optionalScenes`).toBeDefined();
    expect(typeof obs.retryAttempts, `${label}: retryAttempts`).toBe("number");
    expect(typeof obs.pollIntervalMs, `${label}: pollIntervalMs`).toBe(
        "number",
    );
    expect(typeof obs.logToFile, `${label}: logToFile`).toBe("boolean");
    expect(typeof obs.autoSwitch, `${label}: autoSwitch`).toBe("boolean");
}

/** Run `fn` with `modules` as the stored slices, restoring the real state after. */
function withStoredModules<T>(
    modules: Record<string, Record<string, unknown>> | undefined,
    fn: () => T,
): T {
    const saved = state.settings.modules;
    state.settings.modules = modules as typeof saved;
    try {
        return fn();
    } finally {
        state.settings.modules = saved;
    }
}

describe("config file projection", () => {
    test("splits the core settings from the module sections", () => {
        const st = fromConfig({
            uuid: "u",
            hostname: "box",
            role: "relay",
            autostart: true,
            srtla: { listenPort: "9000", remoteHost: "h", remotePort: "1" },
            modems: { modems: ["wwan0"] },
        });
        expect(st.settings).toMatchObject({
            uuid: "u",
            hostname: "box",
            role: "relay",
        });
        expect(st.autostart).toBe(true);
        expect(st.data).toEqual({
            srtla: { listenPort: "9000", remoteHost: "h", remotePort: "1" },
            modems: { modems: ["wwan0"] },
        });
    });
});

describe("switcher fields fold into the obs module slice", () => {
    test("defaultModules seeds a complete obs switcher slice", () => {
        expectCompleteObsSwitcher(
            "default",
            defaultModules("relay")[OBS] as unknown as ObsSwitcherFields,
        );
    });

    test("a config without stored modules gets a complete obs switcher slice", () => {
        withStoredModules(undefined, () => {
            expectCompleteObsSwitcher(
                "fresh",
                ensureModuleSlices("relay")[
                    OBS
                ] as unknown as ObsSwitcherFields,
            );
        });
    });

    test("stored obs values win when the switcher fields are incomplete", () => {
        withStoredModules(
            {
                [OBS]: {
                    enabled: true,
                    obsUrl: "ws://1.2.3.4:4455",
                    obsPassword: "pw",
                    sceneEvents: true,
                    pollIntervalMs: 5000,
                    triggers: { rtt: 900 },
                    obsSourceName: "SRTLA-1",
                },
            },
            () => {
                const obs = ensureModuleSlices("relay")[
                    OBS
                ] as unknown as ObsSwitcherFields;
                expectCompleteObsSwitcher("overrides", obs);
                expect(obs.obsUrl, "keeps obs url").toBe("ws://1.2.3.4:4455");
                expect(obs.pollIntervalMs).toBe(5000);
                expect(obs.triggers?.rtt).toBe(900);
                expect(typeof obs.triggers?.low, "low backfilled").toBe(
                    "number",
                );
                expect(obs.obsSourceName).toBe("SRTLA-1");
            },
        );
    });

    test("an obs slice that lacks the switcher fields gets them from the defaults", () => {
        withStoredModules(
            { [OBS]: { enabled: true, obsUrl: "ws://1.2.3.4:4455" } },
            () => {
                const obs = ensureModuleSlices("relay")[
                    OBS
                ] as unknown as ObsSwitcherFields;
                expectCompleteObsSwitcher("backfilled", obs);
                expect(obs.obsUrl, "keeps obs url").toBe("ws://1.2.3.4:4455");
            },
        );
    });
});
