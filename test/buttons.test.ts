import { describe, expect, test } from "bun:test";
import {
	BUTTONS_FIELD,
	buttonDevices,
	mergedParams,
	orphanedButtons,
	parseButtons,
	serializeButtons,
} from "../modules/buttons/types";
import {
	ALL_MODULES,
	dashboardActionKey,
	dashboardActionsFor,
	deviceWidgetConfigFields,
	isFleetWidgetType,
	validateDeviceWidgetConfig,
	WIDGET_SIZES,
} from "../shared/registry";
import type { Status } from "../shared/types";

const status = (
	role: Status["role"],
	enabled: Record<string, boolean>,
): Status => ({
	role,
	setupRequired: false,
	state: { autostart: false },
	modules: Object.fromEntries(
		Object.entries(enabled).map(([id, on]) => [id, { enabled: on }]),
	),
});

describe("dashboard action catalogue (status.actions)", () => {
	test("every declared action fires one of its module's methods", () => {
		for (const mod of ALL_MODULES)
			for (const action of mod.dashboardActions ?? [])
				expect(mod.methods, `${mod.id}.${action.id}`).toContain(action.method);
	});

	test("merges the actions of the enabled modules that serve the role", () => {
		const keys = dashboardActionsFor(
			status("combined", { encoder: true, relay: true, modems: false }),
		).map((a) => a.key);
		expect(keys).toContain(dashboardActionKey("encoder", "stop"));
		expect(keys).toContain(dashboardActionKey("srtla", "reload"));
		// disabled module → no actions
		expect(keys).not.toContain(dashboardActionKey("modems", "reconfigure"));
		// not enabled at all (no slice) → no actions
		expect(keys.some((k) => k.startsWith("obs-controller."))).toBe(false);
	});

	test("respects the module's roles and the method role overrides", () => {
		// encoder serves encoder+combined: a relay never offers its actions even
		// when the slice claims enabled
		const relay = dashboardActionsFor(
			status("relay", { encoder: true, relay: true }),
		).map((a) => a.key);
		expect(relay.some((k) => k.startsWith("encoder."))).toBe(false);
		expect(relay).toContain(dashboardActionKey("srtla", "stop"));
		// stream.stop is a combined-only method (methodRoles)
		const encoder = dashboardActionsFor(
			status("encoder", { encoder: true }),
		).map((a) => a.key);
		expect(encoder).toContain(dashboardActionKey("encoder", "stop"));
		expect(encoder).not.toContain(dashboardActionKey("encoder", "stream-stop"));
		const combined = dashboardActionsFor(
			status("combined", { encoder: true }),
		).map((a) => a.key);
		expect(combined).toContain(dashboardActionKey("encoder", "stream-stop"));
	});

	test("entries carry the owning module and the stored key", () => {
		const [entry] = dashboardActionsFor(
			status("encoder", { encoder: true }),
		).filter((a) => a.id === "bitrate-low");
		expect(entry).toMatchObject({
			module: "encoder",
			moduleTitle: "Encoder",
			key: "encoder.bitrate-low",
			method: "encoder.bitrate",
			params: { maxBitrate: 1500 },
		});
	});
});

describe("buttons widget config", () => {
	test("is a registered fleet widget with a hidden buttons field", () => {
		expect(WIDGET_SIZES.get("buttons")).toEqual({ w: 4, h: 4 });
		expect(isFleetWidgetType("buttons")).toBe(true);
		expect(deviceWidgetConfigFields("buttons")).toEqual([
			{ name: BUTTONS_FIELD, type: "hidden" },
		]);
		// other device widgets keep no config and stay device-bound
		expect(deviceWidgetConfigFields("relay")).toEqual([]);
		expect(isFleetWidgetType("relay")).toBe(false);
	});

	test("parses and round-trips the stored layout", () => {
		expect(parseButtons("")).toEqual([]);
		expect(parseButtons(undefined)).toEqual([]);
		const buttons = parseButtons(
			JSON.stringify([
				{ deviceId: "d1", actionId: "encoder.stop" },
				{
					deviceId: "d2",
					actionId: "encoder.start",
					labelOverride: "GO",
					iconOverride: "",
					paramsOverride: { pipeline: "p" },
				},
			]),
		);
		expect(buttons).toEqual([
			{ deviceId: "d1", actionId: "encoder.stop" },
			{
				deviceId: "d2",
				actionId: "encoder.start",
				labelOverride: "GO",
				paramsOverride: { pipeline: "p" },
			},
		]);
		expect(parseButtons(serializeButtons(buttons))).toEqual(buttons);
		expect(buttonDevices([...buttons, buttons[0]])).toEqual(["d1", "d2"]);
	});

	test("rejects malformed layouts", () => {
		const b = (extra: string) => `[{"deviceId":"d","actionId":"a"${extra}}]`;
		expect(() => parseButtons("nope")).toThrow("JSON array");
		expect(() => parseButtons('{"actionId":"x"}')).toThrow("JSON array");
		expect(() => parseButtons("[{}]")).toThrow("deviceId");
		expect(() => parseButtons('[{"deviceId":"d"}]')).toThrow("actionId");
		expect(() => parseButtons(b(',"labelOverride":1'))).toThrow("labelOverride");
		expect(() => parseButtons(b(',"paramsOverride":[]'))).toThrow(
			"paramsOverride",
		);
		expect(() => parseButtons(b(',"foo":1'))).toThrow("unknown field");
	});

	test("params override wins over the action defaults", () => {
		const action = {
			id: "x",
			key: "m.x",
			module: "m",
			moduleTitle: "M",
			label: "x",
			method: "m.x",
			params: { a: 1, b: 2 },
		};
		const button = { deviceId: "d", actionId: "m.x" };
		expect(mergedParams(action, button)).toEqual({ a: 1, b: 2 });
		expect(
			mergedParams(action, { ...button, paramsOverride: { b: 3, c: 4 } }),
		).toEqual({ a: 1, b: 3, c: 4 });
	});

	test("server validation: foreign devices are always rejected; strict also rejects gone devices and unknown actions", () => {
		const st = status("combined", { encoder: true });
		st.actions = dashboardActionsFor(st);
		const context = (strict: boolean) => ({
			strict,
			status: undefined,
			deviceStatus: (id: string) => (id === "mine" ? st : undefined),
			ownsDevice: (id: string) => id === "mine" || id === "silent",
			// "theirs" is another user's live device; "gone" was pruned
			deviceExists: (id: string) => id !== "gone",
		});
		const layout = (...buttons: { deviceId: string; actionId: string }[]) => ({
			[BUTTONS_FIELD]: JSON.stringify(buttons),
		});
		const ok = layout({ deviceId: "mine", actionId: "encoder.stop" });
		const orphan = layout(
			{ deviceId: "mine", actionId: "encoder.stop" },
			{ deviceId: "mine", actionId: "obs-controller.stream-start" },
		);
		const foreign = layout({ deviceId: "theirs", actionId: "encoder.stop" });
		const gone = layout({ deviceId: "gone", actionId: "encoder.stop" });
		// a device of mine that never reported a status has no catalogue to check
		const silent = layout({ deviceId: "silent", actionId: "whatever.x" });
		const validate = (config: Record<string, string>, strict: boolean) => () =>
			validateDeviceWidgetConfig("buttons", config, context(strict));
		expect(validate(ok, true)).not.toThrow();
		expect(validate(orphan, true)).toThrow("obs-controller.stream-start");
		expect(validate(foreign, true)).toThrow("Device not available: theirs");
		expect(validate(silent, true)).not.toThrow();
		expect(validate(gone, true)).toThrow("Device not available: gone");
		// lenient saves keep orphaned actions and pruned devices, never foreign ones
		expect(validate(orphan, false)).not.toThrow();
		expect(validate(gone, false)).not.toThrow();
		expect(validate(foreign, false)).toThrow("Device not available: theirs");
		// structural errors are always rejected
		expect(validate({ [BUTTONS_FIELD]: "[1]" }, false)).toThrow("deviceId");
		expect(
			orphanedButtons(parseButtons(orphan[BUTTONS_FIELD]), (id) =>
				id === "mine" ? st.actions : undefined,
			).map((b) => b.actionId),
		).toEqual(["obs-controller.stream-start"]);
	});
});
