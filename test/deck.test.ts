import { describe, expect, test } from "bun:test";
import {
    buttonDevices,
    DECK_FIELD,
    DECK_GRID_COLUMNS,
    layoutButtons,
    mergedParams,
    nextButtonSlot,
    orphanedButtons,
    parseButtons,
    serializeButtons,
} from "../modules/deck/types";
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
        for (const mod of ALL_MODULES) {
            if (mod.dashboardActions === undefined) continue;
            // A status factory's action set depends on the status, so resolve
            // it for a minimal status before checking its methods.
            const actions =
                typeof mod.dashboardActions === "function"
                    ? mod.dashboardActions(
                          status("combined", {
                              [mod.configKey ?? mod.id]: true,
                          }),
                      )
                    : mod.dashboardActions;
            for (const action of actions)
                expect(mod.methods, `${mod.id}.${action.id}`).toContain(
                    action.method,
                );
        }
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
        expect(encoder).not.toContain(
            dashboardActionKey("encoder", "stream-stop"),
        );
        const combined = dashboardActionsFor(
            status("combined", { encoder: true }),
        ).map((a) => a.key);
        expect(combined).toContain(
            dashboardActionKey("encoder", "stream-stop"),
        );
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

    test("emits one mute/toggle action per live OBS audio source", () => {
        const st = status("combined", { "obs-controller": true });
        // status() spreads module fragments to the top level, so the source
        // list lands at status.obs.audioSources (as the device reports it).
        st.obs = {
            audioSources: [
                { name: "Mic", muted: false },
                { name: "Desktop", muted: true },
            ],
        };
        const actions = dashboardActionsFor(st);
        const keys = actions.map((a) => a.key);
        // base actions are always present
        expect(keys).toContain(
            dashboardActionKey("obs-controller", "stream-start"),
        );
        // one toggle per source, keyed by the raw source name
        expect(keys).toContain(
            dashboardActionKey("obs-controller", "mute:Desktop"),
        );
        // a muted source offers to UNMUTE (sets inputMuted:false, 🔊)
        const desktop = actions.find((a) => a.id === "mute:Desktop")!;
        expect(desktop).toMatchObject({
            method: "obs.request",
            params: {
                requestType: "SetInputMute",
                requestData: { inputName: "Desktop", inputMuted: false },
            },
        });
        expect(desktop.icon).toBe("🔊");
        // an unmuted source offers to MUTE (sets inputMuted:true, 🔇)
        const mic = actions.find((a) => a.id === "mute:Mic")!;
        expect(mic).toMatchObject({
            params: {
                requestType: "SetInputMute",
                requestData: { inputName: "Mic", inputMuted: true },
            },
        });
        expect(mic.icon).toBe("🔇");
    });

    test("emits one scene-switch action per OBS scene", () => {
        const st = status("combined", { "obs-controller": true });
        st.obs = { scenes: ["Live", "BRB"], currentScene: "Live" };
        const scenes = dashboardActionsFor(st).filter((a) =>
            a.id.startsWith("scene:"),
        );
        expect(scenes.map((a) => a.key)).toEqual([
            dashboardActionKey("obs-controller", "scene:Live"),
            dashboardActionKey("obs-controller", "scene:BRB"),
        ]);
        // the live scene is marked
        expect(scenes.map((a) => a.icon)).toEqual(["🔴", "🎬"]);
        expect(scenes[1]).toMatchObject({
            label: "BRB",
            method: "obs.request",
            params: {
                requestType: "SetCurrentProgramScene",
                requestData: { sceneName: "BRB" },
            },
        });
    });

    test("the OBS factory hides mute buttons when no sources are reported", () => {
        // enabled module with no obs fragment → base actions only
        const keys = dashboardActionsFor(
            status("combined", { "obs-controller": true }),
        ).map((a) => a.id);
        expect(keys).toContain("stream-start");
        expect(keys.some((k) => k.startsWith("mute:"))).toBe(false);
    });
});

describe("deck widget config", () => {
    test("is a registered fleet widget with a hidden buttons field", () => {
        expect(WIDGET_SIZES.get("deck")).toEqual({ w: 4, h: 4 });
        expect(isFleetWidgetType("deck")).toBe(true);
        expect(deviceWidgetConfigFields("deck")).toEqual([
            { name: DECK_FIELD, type: "hidden" },
        ]);
        // other device widgets keep no config and stay device-bound
        expect(deviceWidgetConfigFields("relay")).toEqual([]);
        expect(isFleetWidgetType("relay")).toBe(false);
    });

    test("parses and round-trips the stored layout", () => {
        expect(parseButtons("")).toEqual([]);
        expect(parseButtons(undefined)).toEqual([]);
        const deck = parseButtons(
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
        expect(deck).toEqual([
            { deviceId: "d1", actionId: "encoder.stop" },
            {
                deviceId: "d2",
                actionId: "encoder.start",
                labelOverride: "GO",
                paramsOverride: { pipeline: "p" },
            },
        ]);
        expect(parseButtons(serializeButtons(deck))).toEqual(deck);
        expect(buttonDevices([...deck, deck[0]])).toEqual(["d1", "d2"]);
    });

    test("round-trips the internal-grid position (x/y/w/h) when present", () => {
        const deck = parseButtons(
            JSON.stringify([
                {
                    deviceId: "d1",
                    actionId: "encoder.stop",
                    x: 4,
                    y: 2,
                    w: 3,
                    h: 2,
                },
            ]),
        );
        expect(deck).toEqual([
            {
                deviceId: "d1",
                actionId: "encoder.stop",
                x: 4,
                y: 2,
                w: 3,
                h: 2,
            },
        ]);
        expect(parseButtons(serializeButtons(deck))).toEqual(deck);
    });

    test("rejects positions that are not sane grid coordinates", () => {
        const at = (x?: number, y?: number, w?: number, h?: number) =>
            JSON.stringify([
                {
                    deviceId: "d",
                    actionId: "a",
                    ...(x !== undefined ? { x } : {}),
                    ...(y !== undefined ? { y } : {}),
                    ...(w !== undefined ? { w } : {}),
                    ...(h !== undefined ? { h } : {}),
                },
            ]);
        // negative / non-integer origin
        expect(() => parseButtons(at(-1, 0, 2, 2))).toThrow("position");
        expect(() => parseButtons(at(0, 0.5, 2, 2))).toThrow("position");
        // a key must have a size (w/h >= 1) when it has an origin
        expect(() => parseButtons(at(0, 0, 0, 2))).toThrow("size");
        expect(() => parseButtons(at(0, 0, 2, 0))).toThrow("size");
        // a key must not run past the last column
        expect(() => parseButtons(at(DECK_GRID_COLUMNS - 1, 0, 2, 2))).toThrow(
            "size",
        );
        // fits exactly in the last column
        expect(() => parseButtons(at(10, 0, 2, 2))).not.toThrow();
    });

    test("nextButtonSlot returns the first free cell, skipping occupied ones", () => {
        // empty layout → top-left 2×2
        expect(nextButtonSlot([])).toEqual({ x: 0, y: 0, w: 2, h: 2 });
        const withOne = [
            { deviceId: "d", actionId: "a", x: 0, y: 0, w: 2, h: 2 },
        ];
        // the 2×2 at the origin is taken → next is at x:2
        expect(nextButtonSlot(withOne)).toEqual({ x: 2, y: 0, w: 2, h: 2 });
        // a wide key forces a wrap to the next row
        const wide = [
            { deviceId: "d", actionId: "a", x: 0, y: 0, w: 11, h: 1 },
            { deviceId: "d", actionId: "b", x: 11, y: 0, w: 1, h: 1 },
        ];
        expect(nextButtonSlot(wide)).toEqual({ x: 0, y: 1, w: 2, h: 2 });
    });

    test("layoutButtons keeps stored positions and fills the rest in order", () => {
        const input = [
            { deviceId: "d", actionId: "a", x: 4, y: 0, w: 2, h: 2 },
            { deviceId: "d", actionId: "b" }, // no position → first free (0,0)
            { deviceId: "d", actionId: "c" }, // no position → next free (2,0)
        ];
        const out = layoutButtons(input);
        expect(out).toEqual([
            { deviceId: "d", actionId: "a", x: 4, y: 0, w: 2, h: 2 },
            { deviceId: "d", actionId: "b", x: 0, y: 0, w: 2, h: 2 },
            { deviceId: "d", actionId: "c", x: 2, y: 0, w: 2, h: 2 },
        ]);
        // pure: the input is not mutated
        expect(input[1].x).toBeUndefined();
    });

    test("rejects malformed layouts", () => {
        const b = (extra: string) =>
            `[{"deviceId":"d","actionId":"a"${extra}}]`;
        expect(() => parseButtons("nope")).toThrow("JSON array");
        expect(() => parseButtons('{"actionId":"x"}')).toThrow("JSON array");
        expect(() => parseButtons("[{}]")).toThrow("deviceId");
        expect(() => parseButtons('[{"deviceId":"d"}]')).toThrow("actionId");
        expect(() => parseButtons(b(',"labelOverride":1'))).toThrow(
            "labelOverride",
        );
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
        const layout = (
            ...deck: { deviceId: string; actionId: string }[]
        ) => ({
            [DECK_FIELD]: JSON.stringify(deck),
        });
        const ok = layout({ deviceId: "mine", actionId: "encoder.stop" });
        const orphan = layout(
            { deviceId: "mine", actionId: "encoder.stop" },
            { deviceId: "mine", actionId: "obs-controller.stream-start" },
        );
        const foreign = layout({
            deviceId: "theirs",
            actionId: "encoder.stop",
        });
        const gone = layout({ deviceId: "gone", actionId: "encoder.stop" });
        // a device of mine that never reported a status has no catalogue to check
        const silent = layout({ deviceId: "silent", actionId: "whatever.x" });
        const validate =
            (config: Record<string, string>, strict: boolean) => () =>
                validateDeviceWidgetConfig("deck", config, context(strict));
        expect(validate(ok, true)).not.toThrow();
        expect(validate(orphan, true)).toThrow("obs-controller.stream-start");
        expect(validate(foreign, true)).toThrow("Device not available: theirs");
        expect(validate(silent, true)).not.toThrow();
        expect(validate(gone, true)).toThrow("Device not available: gone");
        // lenient saves keep orphaned actions and pruned devices, never foreign ones
        expect(validate(orphan, false)).not.toThrow();
        expect(validate(gone, false)).not.toThrow();
        expect(validate(foreign, false)).toThrow(
            "Device not available: theirs",
        );
        // structural errors are always rejected
        expect(validate({ [DECK_FIELD]: "[1]" }, false)).toThrow("deviceId");
        expect(
            orphanedButtons(parseButtons(orphan[DECK_FIELD]), (id) =>
                id === "mine" ? st.actions : undefined,
            ).map((b) => b.actionId),
        ).toEqual(["obs-controller.stream-start"]);
    });
});
