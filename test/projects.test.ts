/*
 * Projects (TODO/01-projects.md): the /api/projects endpoints over a live
 * control server — CRUD, membership with roles, the invite links and the
 * permission matrix (owner / editor / viewer).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");

let tempDir: string;
let databasePath: string;
let port: number;
let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
let baseUrl: string;

const alice = "projects-alice";
const bob = "projects-bob";
const carol = "projects-carol";
const password = "test-password-123";

async function availablePort(): Promise<number> {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => resolve());
    });
    const address = listener.address();
    if (!address || typeof address === "string")
        throw new Error("Unable to allocate a local TCP port");
    await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
    });
    return address.port;
}

async function startServer(): Promise<void> {
    serverProcess = Bun.spawn(
        [
            process.execPath,
            "server/main.ts",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--db",
            databasePath,
        ],
        { cwd: projectRoot, stdout: "ignore", stderr: "ignore" },
    );
    baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/healthz`, {
                signal: AbortSignal.timeout(500),
            });
            if (response.ok) return;
            lastError = new Error(`Health check returned ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await Bun.sleep(50);
    }
    await stopServer();
    throw new Error(
        `Control server did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
}

async function stopServer(): Promise<void> {
    const child = serverProcess;
    serverProcess = undefined;
    if (!child) return;
    child.kill();
    await child.exited;
}

/** POST /api/register (the first account needs no invite). */
async function register(username: string, invite?: string): Promise<void> {
    const response = await fetch(`${baseUrl}/api/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, ...(invite ? { invite } : {}) }),
    });
    expect(response.status, `register ${username}: ${await response.text()}`).toBe(201);
}

async function login(username: string): Promise<string> {
    const response = await fetch(`${baseUrl}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Login did not set a session cookie");
    return cookie;
}

async function api(
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            cookie,
            ...(body !== undefined
                ? { "content-type": "application/json" }
                : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: () => response.json() };
}

let aliceCookie: string;
let bobCookie: string;
let carolCookie: string;
let projectId: string;
let aliceId: number;
let bobId: number;

beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "irlctrl-projects-"));
    databasePath = join(tempDir, "users.sqlite");
    port = await availablePort();
    await startServer();
    await register(alice);
    aliceCookie = await login(alice);
    // A second account needs a registration invite (the admin mints one).
    const invite = await api("POST", "/api/invitations", aliceCookie);
    const code = (await invite.json())["code"] as string;
    await register(bob, code);
    bobCookie = await login(bob);
    const carolInvite = await api("POST", "/api/invitations", aliceCookie);
    const carolCode = (await carolInvite.json())["code"] as string;
    await register(carol, carolCode);
    carolCookie = await login(carol);

    // The fixture project: alice's, bob joined through an invite link.
    const created = await api("POST", "/api/projects", aliceCookie, {
        name: "Fixture",
    });
    expect(created.status).toBe(201);
    projectId = ((await created.json())["project"] as { id: string }).id;
    const members0 = await api(
        "GET",
        `/api/projects/${projectId}/members`,
        aliceCookie,
    );
    expect(members0.status).toBe(200);
    aliceId = ((await members0.json())["members"] as { userId: number }[])[0]
        .userId;
    const link = await api(
        "POST",
        `/api/projects/${projectId}/invites`,
        aliceCookie,
        { role: "editor" },
    );
    expect(link.status).toBe(201);
    const url = ((await link.json())["invite"] as { url: string }).url;
    const token = url.split("/").pop()!;
    const joined = await api(
        "POST",
        `/api/projects/join/${token}`,
        bobCookie,
    );
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({
        project: { id: projectId, role: "editor" },
    });
    const members1 = await api(
        "GET",
        `/api/projects/${projectId}/members`,
        aliceCookie,
    );
    bobId = (
        (await members1.json())["members"] as { userId: number; login: string }[]
    ).find((m) => m.login === bob)!.userId;
});

afterAll(async () => {
    await stopServer();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("projects", () => {
    test("require authentication", async () => {
        const response = await fetch(`${baseUrl}/api/projects`);
        expect(response.status).toBe(401);
    });

    test("lists the user's projects with their role", async () => {
        const mine = await api("GET", "/api/projects", aliceCookie);
        expect(mine.status).toBe(200);
        const list = (await mine.json())["projects"] as {
            id: string;
            name: string;
            role: string;
        }[];
        // Every account gets an auto-created Personal project (migration 0012)
        // in addition to the fixtures they created or joined.
        const personal = list.filter((p) => p.id.startsWith("personal-"));
        expect(personal).toHaveLength(1);
        expect(personal[0]).toMatchObject({ name: "Personal", role: "owner" });
        expect(list.find((p) => p.id === projectId)).toMatchObject({
            id: projectId,
            name: "Fixture",
            role: "owner",
        });
        const bobList = await api("GET", "/api/projects", bobCookie);
        const bobProjects = (await bobList.json())["projects"] as {
            id: string;
            role: string;
        }[];
        expect(
            bobProjects.filter((p) => p.id.startsWith("personal-")),
        ).toHaveLength(1);
        expect(bobProjects.find((p) => p.id === projectId)).toMatchObject({
            role: "editor",
        });
    });

    test("creates a project with the creator as owner", async () => {
        const created = await api(
            "POST",
            "/api/projects",
            bobCookie,
            { name: "Bob's project" },
        );
        expect(created.status).toBe(201);
        const project = (await created.json())["project"] as {
            role: string;
        };
        expect(project.role).toBe("owner");
    });

    test("rejects a blank project name", async () => {
        const created = await api(
            "POST",
            "/api/projects",
            aliceCookie,
            { name: "   " },
        );
        expect(created.status).toBe(400);
    });

    test("renames by owner and editor, not viewer", async () => {
        const renamed = await api(
            "PATCH",
            `/api/projects/${projectId}`,
            bobCookie, // editor
            { name: "Renamed" },
        );
        expect(renamed.status).toBe(200);
        expect((await renamed.json())["project"]).toMatchObject({
            name: "Renamed",
        });
    });

    test("lists members (owner first)", async () => {
        const members = await api(
            "GET",
            `/api/projects/${projectId}/members`,
            aliceCookie,
        );
        expect(members.status).toBe(200);
        const list = (await members.json())["members"] as {
            login: string;
            role: string;
        }[];
        expect(list[0]).toMatchObject({ login: alice, role: "owner" });
        expect(list).toHaveLength(2);
    });

    test("the owner changes member roles, the owner row is fixed", async () => {
        const demoted = await api(
            "PATCH",
            `/api/projects/${projectId}/members/${bobId}`,
            aliceCookie,
            { role: "viewer" },
        );
        expect(demoted.status).toBe(200);
        const ownerPatch = await api(
            "PATCH",
            `/api/projects/${projectId}/members/${aliceId}`,
            aliceCookie,
            { role: "viewer" },
        );
        expect(ownerPatch.status).toBe(403);
    });

    test("a viewer cannot rename", async () => {
        const renamed = await api(
            "PATCH",
            `/api/projects/${projectId}`,
            bobCookie, // viewer now
            { name: "Nope" },
        );
        expect(renamed.status).toBe(403);
    });

    test("only the owner mints invite links; an editor only viewer links", async () => {
        const asViewer = await api(
            "POST",
            `/api/projects/${projectId}/invites`,
            bobCookie,
            { role: "viewer" },
        );
        expect(asViewer.status).toBe(403);

        // Promote bob back to editor: editors can mint viewer links…
        await api(
            "PATCH",
            `/api/projects/${projectId}/members/${bobId}`,
            aliceCookie,
            { role: "editor" },
        );
        const editorViewer = await api(
            "POST",
            `/api/projects/${projectId}/invites`,
            bobCookie,
            { role: "viewer" },
        );
        expect(editorViewer.status).toBe(201);
        // …but not editor links.
        const editorEditor = await api(
            "POST",
            `/api/projects/${projectId}/invites`,
            bobCookie,
            { role: "editor" },
        );
        expect(editorEditor.status).toBe(403);
    });

    test("invite links list (owner) and revoke", async () => {
        const listed = await api(
            "GET",
            `/api/projects/${projectId}/invites`,
            aliceCookie,
        );
        expect(listed.status).toBe(200);
        const invites = (await listed.json())["invites"] as {
            id: string;
            role: string;
            url: string;
        }[];
        expect(invites.length).toBeGreaterThanOrEqual(1);
        expect(invites[0].url).toContain(`/projects/join/`);

        const revoked = await api(
            "DELETE",
            `/api/projects/${projectId}/invites/${invites[0].id}`,
            aliceCookie,
        );
        expect(revoked.status).toBe(200);
        const after = await api(
            "GET",
            `/api/projects/${projectId}/invites`,
            aliceCookie,
        );
        const remaining = (await after.json())["invites"] as { id: string }[];
        expect(
            remaining.some((i) => i.id === invites[0].id),
        ).toBe(false);
    });

    test("the owner cannot be removed", async () => {
        const removed = await api(
            "DELETE",
            `/api/projects/${projectId}/members/${aliceId}`,
            aliceCookie,
        );
        expect(removed.status).toBe(403);
    });

    test("a non-owner cannot delete the project", async () => {
        const removed = await api(
            "DELETE",
            `/api/projects/${projectId}`,
            bobCookie,
        );
        expect(removed.status).toBe(403);
    });

    test("previews the current project name without consuming the invite", async () => {
        const created = await api("POST", "/api/projects", aliceCookie, {
            name: "Preview project",
        });
        expect(created.status).toBe(201);
        const previewProjectId = (
            (await created.json())["project"] as { id: string }
        ).id;
        const link = await api(
            "POST",
            `/api/projects/${previewProjectId}/invites`,
            aliceCookie,
            { role: "viewer" },
        );
        expect(link.status).toBe(201);
        const token = ((await link.json())["invite"] as { url: string }).url
            .split("/")
            .pop()!;
        const path = `/api/projects/join/${token}`;

        expect((await fetch(`${baseUrl}${path}`)).status).toBe(401);
        const preview = await fetch(`${baseUrl}${path}`, {
            headers: { cookie: carolCookie },
        });
        expect(preview.status).toBe(200);
        expect(preview.headers.get("cache-control")).toBe("no-store");
        expect(await preview.json()).toEqual({
            project: { name: "Preview project" },
        });
        const beforeJoin = await api("GET", "/api/projects", carolCookie);
        expect(
            ((await beforeJoin.json())["projects"] as { id: string }[]).some(
                (project) => project.id === previewProjectId,
            ),
        ).toBe(false);

        const renamed = await api(
            "PATCH",
            `/api/projects/${previewProjectId}`,
            aliceCookie,
            { name: "Renamed preview project" },
        );
        expect(renamed.status).toBe(200);
        const again = await api("GET", path, carolCookie);
        expect(again.status).toBe(200);
        expect(await again.json()).toEqual({
            project: { name: "Renamed preview project" },
        });
        expect((await api("GET", `${path}/extra`, carolCookie)).status).toBe(404);

        const joined = await api("POST", path, carolCookie);
        expect(joined.status).toBe(200);
        expect(await joined.json()).toEqual({
            project: {
                id: previewProjectId,
                name: "Renamed preview project",
                role: "viewer",
            },
        });
        expect((await api("GET", path, bobCookie)).status).toBe(409);
    });

    test("rejects expired and revoked invite previews", async () => {
        const expiredLink = await api(
            "POST",
            `/api/projects/${projectId}/invites`,
            aliceCookie,
            { role: "viewer" },
        );
        const expiredToken = (
            (await expiredLink.json())["invite"] as { url: string }
        ).url.split("/").pop()!;
        const db = new Database(databasePath);
        try {
            db.query("UPDATE project_invites SET expires_at = ? WHERE token = ?")
                .run("2000-01-01T00:00:00.000Z", expiredToken);
        } finally {
            db.close();
        }
        const expiredPath = `/api/projects/join/${expiredToken}`;
        expect((await api("GET", expiredPath, carolCookie)).status).toBe(410);
        expect((await api("POST", expiredPath, carolCookie)).status).toBe(410);

        const revokedLink = await api(
            "POST",
            `/api/projects/${projectId}/invites`,
            aliceCookie,
            { role: "viewer" },
        );
        const revoked = (await revokedLink.json())["invite"] as {
            id: string;
            url: string;
        };
        expect(
            (
                await api(
                    "DELETE",
                    `/api/projects/${projectId}/invites/${revoked.id}`,
                    aliceCookie,
                )
            ).status,
        ).toBe(200);
        const revokedToken = revoked.url.split("/").pop()!;
        expect(
            (await api("GET", `/api/projects/join/${revokedToken}`, carolCookie))
                .status,
        ).toBe(404);
    });

    test("a used invite cannot be joined twice", async () => {
        const link = await api(
            "POST",
            `/api/projects/${projectId}/invites`,
            aliceCookie,
            { role: "viewer" },
        );
        const token = ((await link.json())["invite"] as { url: string }).url
            .split("/")
            .pop()!;
        // Carol (no membership yet) takes the link first…
        const first = await fetch(`${baseUrl}/api/projects/join/${token}`, {
            method: "POST",
            headers: { cookie: carolCookie },
        });
        expect(first.status).toBe(200);
        expect(await first.json()).toMatchObject({
            project: { id: projectId, role: "viewer" },
        });
        // …and the single-use link is gone for anyone after her.
        const second = await fetch(`${baseUrl}/api/projects/join/${token}`, {
            method: "POST",
            headers: { cookie: bobCookie },
        });
        expect(second.status).toBe(409);
    });

    test("an unknown invite token is rejected", async () => {
        const preview = await api(
            "GET",
            "/api/projects/join/not-a-real-token",
            aliceCookie,
        );
        expect(preview.status).toBe(404);
        const response = await api(
            "POST",
            "/api/projects/join/not-a-real-token",
            aliceCookie,
        );
        expect(response.status).toBe(404);
    });

    test("deletion cascades (owner only)", async () => {
        // Bob's own project (he is its owner): alice cannot reach it at all.
        const bobProjects = await api("GET", "/api/projects", bobCookie);
        const bobProject = ((
            await bobProjects.json()
        )["projects"] as { id: string; name: string }[]).find(
            (p) => p.name === "Bob's project",
        )!;
        const asAlice = await api(
            "DELETE",
            `/api/projects/${bobProject.id}`,
            aliceCookie,
        );
        expect(asAlice.status).toBe(404);
        const asBob = await api(
            "DELETE",
            `/api/projects/${bobProject.id}`,
            bobCookie,
        );
        expect(asBob.status).toBe(200);
        const membersAfter = await api(
            "GET",
            `/api/projects/${bobProject.id}/members`,
            bobCookie,
        );
        expect(membersAfter.status).toBe(404);
    });

    test("device tokens: project-scoped CRUD with the role matrix", async () => {
        // Fixtures at this point in the file: alice = owner, bob = editor,
        // carol = viewer (joined in an earlier test).
        // Owner can create; the response carries the full value.
        const created = await api(
            "POST",
            `/api/projects/${projectId}/tokens`,
            aliceCookie,
        );
        expect(created.status).toBe(201);
        const createdToken = (await created.json())["token"] as {
            id: number;
            token: string;
            createdAt: string;
        };
        expect(createdToken.token).toMatch(/^[0-9a-f]{48}$/);
        expect(createdToken.id).toBeGreaterThan(0);

        // The list shows the value (so it can be copied) and is visible to any
        // member — bob (editor) sees the one alice created.
        const bobList = await api(
            "GET",
            `/api/projects/${projectId}/tokens`,
            bobCookie,
        );
        expect(bobList.status).toBe(200);
        const bobTokens = (await bobList.json())["tokens"] as {
            id: number;
            token: string;
        }[];
        expect(
            bobTokens.find((t) => t.id === createdToken.id),
        ).toMatchObject({ token: createdToken.token });

        // An editor can create, and can revoke any token in the project
        // (project admins manage device access, not just their own).
        const bobCreated = await api(
            "POST",
            `/api/projects/${projectId}/tokens`,
            bobCookie,
        );
        expect(bobCreated.status).toBe(201);
        const bobToken = (await bobCreated.json())["token"] as {
            id: number;
        };
        const bobDeletesAlice = await api(
            "DELETE",
            `/api/projects/${projectId}/tokens/${createdToken.id}`,
            bobCookie,
        );
        expect(bobDeletesAlice.status).toBe(200);

        // A viewer can read the list but not create or revoke.
        expect(
            (await api("GET", `/api/projects/${projectId}/tokens`, carolCookie))
                .status,
        ).toBe(200);
        expect(
            (await api(
                "POST",
                `/api/projects/${projectId}/tokens`,
                carolCookie,
            )).status,
        ).toBe(403);
        expect(
            (await api(
                "DELETE",
                `/api/projects/${projectId}/tokens/${bobToken.id}`,
                carolCookie,
            )).status,
        ).toBe(403);

        // A non-member has no reach at all: a uniform 404.
        const invite = await api("POST", "/api/invitations", aliceCookie);
        const code = (await invite.json())["code"] as string;
        await register("projects-dave", code);
        const daveCookie = await login("projects-dave");
        expect(
            (await api("GET", `/api/projects/${projectId}/tokens`, daveCookie))
                .status,
        ).toBe(404);
        expect(
            (await api(
                "POST",
                `/api/projects/${projectId}/tokens`,
                daveCookie,
            )).status,
        ).toBe(404);
    });
});
