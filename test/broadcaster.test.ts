import { describe, expect, test } from "bun:test";
import type { ModuleCore } from "../backend/client/module-core";
import type { ModuleStartContext } from "../shared/module-contract";
import broadcaster from "../modules/broadcaster/backend";
import {
	configuredOutputs,
	effectiveOutputUrl,
	outputMetadata,
} from "../modules/broadcaster/persistence";

describe("broadcaster persistence", () => {
	test("masks keys and retains a blank key at its submitted row", () => {
		const outputs = configuredOutputs(
			[
				{ service: "custom", url: "rtmp://ingest.example/live", key: "" },
				{
					service: "custom",
					url: "rtmps://backup.example/app",
					key: "new-key",
				},
			],
			["existing-key", "old-second-key"],
		);
		expect(outputs.map((output) => output.key)).toEqual([
			"existing-key",
			"new-key",
		]);
		expect(
			effectiveOutputUrl(outputs[0].url, outputs[0].key, true),
		).toBe("rtmp://ingest.example/live/***");
		expect(JSON.stringify(outputMetadata(outputs))).not.toContain(
			"existing-key",
		);
	});
});

describe("broadcaster module lifecycle", () => {
	test("starts and stops through module methods with public status only", async () => {
		const profilesDir = `${import.meta.dir}/../modules/broadcaster/defaults/profiles`;
		const coreState: {
			settings: {
				role: string;
				modules: Record<
					string,
					Record<string, unknown> & { enabled: boolean }
				>;
			};
			autostart: boolean;
			data: Record<string, unknown>;
		} = {
			settings: {
				role: "broadcaster",
				modules: {
					broadcaster: {
						enabled: true,
						outputs: [
							{
								service: "custom",
								url: "rtmp://ingest.example/live",
								keyConfigured: true,
							},
						],
						profile: "copy",
						profilesDir,
					},
				},
			},
			autostart: false,
			data: {
				broadcaster: {
					outputsConfigured: true,
					outputKeys: ["private-stream-key"],
				},
				unrelatedSetting: "preserve-me",
			},
		};
		let stateNotifications = 0;
		const core = {
			config: {
				argv: [],
				DRY_RUN: true,
				LOG_FILE: "",
				ROLE: "broadcaster",
			},
			role: () => "broadcaster",
			state: coreState,
			saveState: async () => {},
			notifyStateChange: () => {
				stateNotifications += 1;
			},
			onStateChange: () => () => {},
			moduleEnabled: () => true,
			cancelAutostart: () => {},
			logEvent: () => {},
			run: () => {},
			writeFileAtomic: async () => {},
			Supervisor: class {},
			requireCapability: () => {
				throw new Error("not used");
			},
			hasCapability: () => false,
			listDevices: async () => [],
			requestDevice: async () => ({}),
		} as unknown as ModuleCore;

		broadcaster.bind?.(core);
		const emitted: unknown[] = [];
		const context: ModuleStartContext<ModuleCore> = {
			config: {},
			core,
			emit: (_event, data) => emitted.push(data),
			log: () => {},
		};
		await broadcaster.start(context);
		expect(coreState.autostart).toBe(false);
		expect(coreState.data.unrelatedSetting).toBe("preserve-me");
		expect(
			(coreState.data.broadcaster as Record<string, unknown>).outputKeys,
		).toEqual(["private-stream-key"]);
		expect(
			coreState.settings.modules.broadcaster.outputs,
		).toEqual([
			{
				service: "custom",
				url: "rtmp://ingest.example/live",
				keyConfigured: true,
			},
		]);

		const started = (await broadcaster.dispatch(
			"broadcaster.start",
			{},
		)) as { state: string };
		expect(started.state).toBe("running");
		const running = await broadcaster.status?.();
		expect(running?.state).toMatchObject({
			stream: "running",
			outputs: [
				{
					service: "custom",
					url: "rtmp://ingest.example/live",
					keyConfigured: true,
				},
			],
		});
		expect(JSON.stringify(running)).not.toContain("private-stream-key");
		expect(stateNotifications).toBeGreaterThan(0);
		expect(emitted.length).toBeGreaterThan(0);

		broadcaster.configure?.(
			{
				outputs: [
					{
						service: "custom",
						url: "rtmp://new-ingest.example/live",
						key: "",
					},
				],
			},
			coreState.settings.modules.broadcaster,
		);
		expect(
			(coreState.data.broadcaster as Record<string, unknown>).outputKeys,
		).toEqual(["private-stream-key"]);
		expect(
			JSON.stringify(coreState.settings.modules.broadcaster),
		).not.toContain("private-stream-key");
		expect(coreState.settings.modules.broadcaster.outputs).toEqual([
			{
				service: "custom",
				url: "rtmp://new-ingest.example/live",
				keyConfigured: true,
			},
		]);

		const stopped = (await broadcaster.dispatch(
			"broadcaster.stop",
			{},
		)) as { state: string };
		expect(stopped.state).toBe("idle");
		expect((await broadcaster.status?.())?.state).toMatchObject({
			stream: "idle",
			uptimeMs: 0,
		});
		await broadcaster.stop();
	});
});
