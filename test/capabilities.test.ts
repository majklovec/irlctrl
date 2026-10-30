import { afterEach, describe, expect, test } from "bun:test";
import {
    clearCapabilities,
    hasCapability,
    provideCapability,
    requireCapability,
} from "../backend/client/capabilities";
describe("module capability bus", () => {
    afterEach(clearCapabilities);

    test("provides and requires a registered runtime service", () => {
        const service = { reload: async () => true };
        expect(provideCapability("test.service", service)).toBe(service);
        expect(hasCapability("test.service")).toBe(true);
        expect(requireCapability<typeof service>("test.service")).toBe(service);
    });

    test("reports a missing capability", () => {
        expect(() => requireCapability("stream.srtla")).toThrow(
            'capability "stream.srtla" is not provided by any module',
        );
    });
});
