import { describe, expect, test } from "bun:test";
import {
	type DeviceConfig,
	defaultModules,
	fromConfig,
	type ModulesState,
} from "../backend/client/state";
import type { SwitcherConfig } from "../shared/types";

/**
 * The switcher rides on the OBS module slice; `fromConfig` fills missing
 * switcher fields with the defaults, so the obs slice must always end up with
 * a complete switcher set.
 */
const OBS = "obs-controller";

/** The switcher fields as they now live on the obs module slice (plus the obs
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
	expect(typeof obs.pollIntervalMs, `${label}: pollIntervalMs`).toBe("number");
	expect(typeof obs.logToFile, `${label}: logToFile`).toBe("boolean");
	expect(typeof obs.autoSwitch, `${label}: autoSwitch`).toBe("boolean");
}

describe("switcher fields fold into the obs module slice", () => {
	test("defaultModules seeds a complete obs switcher slice", () => {
		expectCompleteObsSwitcher(
			"default",
			defaultModules("relay")[OBS] as ObsSwitcherFields,
		);
	});

	test("a fresh config (no stored modules) gets a complete obs switcher slice", () => {
		const cfg: Partial<DeviceConfig> = { role: "relay" };
		const st = fromConfig(cfg);
		expectCompleteObsSwitcher(
			"fresh",
			st.settings.modules?.[OBS] as ObsSwitcherFields,
		);
	});

	test("stored obs values win when the switcher fields are incomplete", () => {
		const cfg: Partial<DeviceConfig> = {
			role: "relay",
			modules: {
				[OBS]: {
					enabled: true,
					obsUrl: "ws://1.2.3.4:4455",
					obsPassword: "pw",
					sceneEvents: true,
					pollIntervalMs: 5000,
					triggers: { rtt: 900 },
					obsSourceName: "SRTLA-1",
				},
			} as unknown as ModulesState,
		};
		const st = fromConfig(cfg);
		const obs = st.settings.modules?.[OBS] as ObsSwitcherFields;
		expectCompleteObsSwitcher("overrides", obs);
		expect(obs.obsUrl, "keeps obs url").toBe("ws://1.2.3.4:4455");
		expect(obs.pollIntervalMs).toBe(5000);
		expect(obs.triggers?.rtt).toBe(900);
		expect(typeof obs.triggers?.low, "low backfilled").toBe("number");
		expect(obs.obsSourceName).toBe("SRTLA-1");
	});

	test("an obs slice that lacks the switcher fields gets them from the defaults", () => {
		const cfg: Partial<DeviceConfig> = {
			role: "relay",
			modules: {
				[OBS]: { enabled: true, obsUrl: "ws://1.2.3.4:4455" },
			} as unknown as ModulesState,
		};
		const st = fromConfig(cfg);
		const obs = st.settings.modules?.[OBS] as ObsSwitcherFields;
		expectCompleteObsSwitcher("backfilled", obs);
		expect(obs.obsUrl, "keeps obs url").toBe("ws://1.2.3.4:4455");
	});
});
