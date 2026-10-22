import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAuth } from "../backend/server/auth";
import { createDashboards } from "../backend/server/dashboards";
import { destroyWidgetHub } from "../shared/registry";

function request(path: string, body?: unknown, cookie?: string): Request {
    return new Request(`http://localhost${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            "content-type": "application/json",
            ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

describe("control-server domain contracts", () => {
    let auth: Awaited<ReturnType<typeof createAuth>>;
    let dashboards: ReturnType<typeof createDashboards>;
    const published: { topic: string; message: string }[] = [];

    beforeAll(async () => {
        auth = await createAuth({ noAuth: false, databaseFile: ":memory:" });
        dashboards = createDashboards({
            db: auth.db,
            databaseFile: ":memory:",
            publish: (topic, message) => published.push({ topic, message }),
            ownsDevice: (id, owner) => id === "relay" && owner === "alice",
        });
    });

    afterAll(() => {
        destroyWidgetHub();
        auth.db?.close();
    });

    test("keeps bootstrap, invitations, sessions and token ownership scoped", async () => {
        const registered = await auth.registerResponse(
            request("/api/register", {
                username: "alice",
                password: "password-alice",
            }),
        );
        expect(registered.status).toBe(201);
        expect(await registered.json()).toEqual({
            ok: true,
            user: "alice",
            admin: true,
        });
        const denied = await auth.registerResponse(
            request("/api/register", {
                username: "bob",
                password: "password-bob",
            }),
        );
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({
            ok: false,
            error: "Invitation code required",
        });

        const login = await auth.loginResponse(
            request("/api/login", {
                username: "alice",
                password: "password-alice",
            }),
        );
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")?.split(";")[0];
        expect(cookie).toBeDefined();
        expect(login.headers.get("set-cookie")).toContain(
            "; Path=/; HttpOnly; SameSite=Lax",
        );
        const session = request("/api/profile", undefined, cookie);
        expect(auth.userFromRequest(session)).toBe("alice");

        const invitation = auth.createInvitationResponse(session);
        expect(invitation.status).toBe(201);
        const { code } = await invitation.json();
        const invited = await auth.registerResponse(
            request("/api/register", {
                username: "bob",
                password: "password-bob",
                invite: code,
            }),
        );
        expect(invited.status).toBe(201);
        expect(await invited.json()).toEqual({
            ok: true,
            user: "bob",
            admin: false,
        });
        const reused = await auth.registerResponse(
            request("/api/register", {
                username: "carol",
                password: "password-carol",
                invite: code,
            }),
        );
        expect(reused.status).toBe(403);
        expect(await reused.json()).toEqual({
            ok: false,
            error: "Invitation already used",
        });

        const { token } = await auth.createTokenResponse("alice").json();
        expect(auth.userForToken(token.token)).toBe("alice");
        const foreignDelete = auth.deleteTokenResponse(
            new URL(`http://localhost/api/profile/tokens/${token.id}`),
            "bob",
        );
        expect(foreignDelete.status).toBe(404);
        expect(auth.userForToken(token.token)).toBe("alice");
        expect(
            auth.deleteTokenResponse(
                new URL(`http://localhost/api/profile/tokens/${token.id}`),
                "alice",
            ).status,
        ).toBe(200);
        expect(auth.userForToken(token.token)).toBeNull();
        const logout = auth.logoutResponse(session);
        expect(logout.headers.get("set-cookie")).toBe(
            "srtla_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        expect(auth.userFromRequest(session)).toBeNull();
    });

    test("keeps dashboard validation errors in 200 bodies and conflicts as 409", async () => {
        const call = (method: string, path: string, body?: unknown, user = "alice") => {
            const req = new Request(`http://localhost${path}`, {
                method,
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return dashboards.dashApi(req, new URL(req.url), user);
        };
        const unavailable = await call("POST", "/api/dashboards", {
            name: "Unavailable",
            widgets: [{ type: "relay", deviceId: "other" }],
        });
        expect(unavailable.status).toBe(200);
        expect(await unavailable.json()).toEqual({
            ok: false,
            error: "Device not available: other",
            code: 400,
        });

        const created = await call("POST", "/api/dashboards", {
            name: " Operations ",
            widgets: [{ id: "widget", type: "relay", deviceId: "relay" }],
        });
        expect(created.status).toBe(201);
        const { dashboard } = await created.json();
        expect(dashboard).toMatchObject({
            owner: "alice",
            name: "Operations",
            version: 1,
            columns: 12,
            widgets: [{
                id: "widget",
                deviceId: "relay",
                type: "relay",
                name: "relay",
                x: 0,
                y: 0,
                w: 4,
                h: 4,
                visible: false,
            }],
        });
        expect(published.at(-1)?.topic).toBe("dashboards:alice");
        expect(JSON.parse(published.at(-1)!.message)).toEqual({
            type: "event",
            event: "dashboards.changed",
            data: dashboard,
        });
        expect(dashboards.dashboardsFor("bob")).toEqual([]);
        const path = `/api/dashboards/${dashboard.id}`;
        const foreign = await call("GET", path, undefined, "bob");
        expect(foreign.status).toBe(200);
        expect(await foreign.json()).toEqual({
            ok: false,
            error: "Unknown dashboard",
            code: 404,
        });
        const conflict = await call("PUT", path, {
            name: "Changed",
            widgets: [],
            version: 0,
        });
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toEqual({
            ok: false,
            error: "version conflict",
            current: dashboard,
        });
        expect(auth.db?.prepare("SELECT name, version FROM dashboards").get())
            .toEqual({ name: "Operations", version: 1 });
        const removed = await call("DELETE", path);
        expect(await removed.json()).toEqual({ ok: true, dashboards: [] });
        expect(JSON.parse(published.at(-1)!.message)).toEqual({
            type: "event",
            event: "dashboards.changed",
            data: { id: dashboard.id, deleted: true },
        });
    });

    test("preserves no-auth local identity and disabled registration", async () => {
        const local = await createAuth({
            noAuth: true,
            databaseFile: ":memory:",
        });
        expect(local.db).toBeNull();
        expect(local.userFromRequest(request("/api/profile"))).toBe("local");
        expect(local.userForToken(null)).toBe("local");
        const registration = await local.registerResponse(
            request("/api/register", {
                username: "local",
                password: "password-local",
            }),
        );
        expect(registration.status).toBe(403);
        expect(await registration.json()).toEqual({
            ok: false,
            error: "Registration is disabled",
        });
    });
});
