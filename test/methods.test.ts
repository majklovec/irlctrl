import { describe, expect, test } from "bun:test";
import { handleRequest } from "../backend/client/methods";

describe("device RPC response envelope", () => {
    test("returns a 400 response for invalid JSON", async () => {
        const response = JSON.parse(await handleRequest("{")) as {
            type: string;
            id: unknown;
            method: string;
            ok: boolean;
            code: number;
        };

        expect(response).toMatchObject({
            type: "response",
            id: null,
            method: "",
            ok: false,
            code: 400,
        });
    });

    test("echoes the request id and method for unknown methods", async () => {
        const response = JSON.parse(
            await handleRequest(
                JSON.stringify({
                    id: "request-1",
                    method: "unknown.method",
                    params: {},
                }),
            ),
        ) as {
            type: string;
            id: unknown;
            method: string;
            ok: boolean;
            code: number;
        };

        expect(response).toMatchObject({
            type: "response",
            id: "request-1",
            method: "unknown.method",
            ok: false,
            code: 404,
        });
    });
});
