import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDeviceApiApp } from "../client/backend/api";
import {
	authEnabled,
	authenticate,
	hashPassword,
	verifyPassword,
} from "../client/backend/auth";

describe("password hashing", () => {
	test("hash and verify round-trip", () => {
		const hash = hashPassword("correct horse battery staple");
		expect(hash.startsWith("scrypt$")).toBe(true);
		expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
	});

	test("rejects a wrong password", () => {
		const hash = hashPassword("correct horse battery staple");
		expect(verifyPassword("wrong password", hash)).toBe(false);
	});

	test("rejects malformed hashes", () => {
		expect(verifyPassword("x", "not-a-hash")).toBe(false);
		expect(verifyPassword("x", "scrypt$abcd")).toBe(false);
		expect(verifyPassword("x", "scrypt$abcd$")).toBe(false);
	});

	test("hashes are salted (same password, different hash)", () => {
		expect(hashPassword("same")).not.toBe(hashPassword("same"));
	});
});

// The test process has no device config file, so web auth starts disabled:
// login is unavailable and sessions are unconditionally valid.
describe("login route without registered credentials", () => {
	let app: Awaited<ReturnType<typeof createDeviceApiApp>>;
	let baseUrl: string;

	beforeAll(async () => {
		app = (await createDeviceApiApp()).listen({
			hostname: "127.0.0.1",
			port: 0,
		});
		const port = app.server?.port;
		if (port === undefined) throw new Error("Device API failed to start");
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		await app.stop(true);
	});

	test("auth is off without a config file", () => {
		expect(authEnabled).toBe(false);
		expect(authenticate("admin", "anything")).toBe(false);
	});

	test("POST /login is unavailable while auth is off", async () => {
		const res = await fetch(`${baseUrl}/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "secret" }),
		});
		expect(res.status).toBe(404);
	});

	test("pages are open without a session while auth is off", async () => {
		const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
		expect(res.status).toBe(200);
	});
});
