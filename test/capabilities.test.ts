import { afterEach, describe, expect, test } from "bun:test";
import {
    clearCapabilities,
    hasCapability,
    provideCapability,
    requireCapability,
} from "../client/backend/capabilities";
describe("module capability bus", () => {
    afterEach(clearCapabilities);

    test("provides and requires a registered runtime service", () => {
        const service = { reload: async () => true };
        expect(provideCapability("test.service", service)).toBe(service);
        expect(hasCapability("test.service")).toBe(true);
        expect(requireCapability<typeof service>("test.service")).toBe(service);
    });

    test("reports a missing capability", () => {
        expect(() => requireCapability("stream.relay")).toThrow(
            'capability "stream.relay" is not provided by any module',
        );
    });
});
