import { describe, expect, test } from "bun:test";
import {
    defaultModules,
    methodAllowed,
    safeModules,
} from "../backend/client/modules";
import { state } from "../backend/client/state";
import obsModule from "../modules/obs-controller/backend";

const OBS = "obs-controller";

describe("OBS module role and settings", () => {
    test("defaults enabled on obs while remaining available on other roles", () => {
        expect(obsModule.roles).toBeUndefined();
        expect(obsModule.enabledByDefaultRoles).toEqual(["obs"]);
        expect(defaultModules("obs")[OBS].enabled).toBe(true);
        for (const role of ["relay", "encoder", "combined"])
            expect(defaultModules(role)[OBS].enabled).toBe(false);
    });

    test("OBS methods are unavailable on unrelated roles", () => {
        const savedRole = state.settings.role;
        const savedModules = state.settings.modules;
        try {
            state.settings.role = "obs";
            state.settings.modules = defaultModules("obs");
            expect(methodAllowed("obs.request")).toBe(true);

            state.settings.role = "relay";
            state.settings.modules = defaultModules("relay");
            expect(methodAllowed("obs.request")).toBe(false);
            state.settings.modules[OBS].enabled = true;
            expect(methodAllowed("obs.request")).toBe(true);
        } finally {
            state.settings.role = savedRole;
            state.settings.modules = savedModules;
        }
    });

    test("setup validates and stores the OBS connection in the module slice", async () => {
        await expect(
            obsModule.setup?.({ obsUrl: "https://obs.example" }, "obs"),
        ).rejects.toThrow("ws:// or wss://");
        expect(await obsModule.setup?.({ obsUrl: "ws://localhost:4455" }, "relay"))
            .toBeUndefined();

        const saved = state.settings.modules;
        try {
            state.settings.modules = undefined;
            const apply = await obsModule.setup?.(
                {
                    obsUrl: " wss://obs.example:4455 ",
                    obsPassword: "secret",
                },
                "obs",
            );
            expect(apply).toBeDefined();
            await apply?.();
            expect(state.settings.modules?.[OBS]).toMatchObject({
                enabled: true,
                obsUrl: "wss://obs.example:4455",
                obsPassword: "secret",
            });
            expect(safeModules()[OBS].obsPassword).toEqual({
                configured: true,
            });
            expect(JSON.stringify(safeModules()[OBS])).not.toContain("secret");
        } finally {
            state.settings.modules = saved;
        }
    });

    test("configure updates supplied fields while preserving an omitted password", () => {
        const slice = defaultModules("obs")[OBS];
        obsModule.configure?.(
            { obsUrl: " ws://localhost:4455 ", obsPassword: "secret" },
            slice,
        );
        obsModule.configure?.({ obsUrl: "wss://obs.example:4455" }, slice);

        expect(slice).toMatchObject({
            obsUrl: "wss://obs.example:4455",
            obsPassword: "secret",
        });
        expect(() =>
            obsModule.configure?.({ obsUrl: "https://obs.example" }, slice),
        ).toThrow("ws:// or wss://");
    });
});
