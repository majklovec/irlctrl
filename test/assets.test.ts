import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");

let tempDir: string;
let databasePath: string;
let storagePath: string;
let port: number;
let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
let baseUrl: string;

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
            "server/backend/server.ts",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--db",
            databasePath,
            "--storage",
            storagePath,
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
        `Control server did not start: ${
            lastError instanceof Error ? lastError.message : String(lastError)
        }`,
    );
}

async function stopServer(): Promise<void> {
    const child = serverProcess;
    serverProcess = undefined;
    if (!child) return;
    child.kill();
    await child.exited;
}

/** Register a fresh user (the first needs no invite, later ones do) and
 * return the session cookie. */
async function login(username: string, invite?: string): Promise<string> {
    const registration = await fetch(`${baseUrl}/api/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            username,
            password: "test-password-456",
            ...(invite ? { invite } : {}),
        }),
    });
    expect(registration.status).toBe(201);
    const response = await fetch(`${baseUrl}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: "test-password-456" }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Login did not set a session cookie");
    return cookie;
}

interface Folder {
	id: string;
	parentId: string | null;
	name: string;
	createdAt: number;
	hasChildren: boolean;
	fileCount: number;
}

interface AssetFile {
	id: string;
	folderId: string;
	name: string;
	size: number;
	mimeType: string;
	createdAt: number;
	updatedAt: number;
}

let alice: string;
let bob: string;
let root: Folder;

beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "irlctrl-assets-"));
    databasePath = join(tempDir, "users.db");
    storagePath = join(tempDir, "storage");
    port = await availablePort();
    await startServer();
    alice = await login("assets-alice");
    // The first account is the admin; everyone after needs its invite code.
    const invite = await fetch(`${baseUrl}/api/invitations`, {
        method: "POST",
        headers: { cookie: alice },
    });
    expect(invite.status).toBe(201);
    const { code } = (await invite.json()) as { code: string };
    bob = await login("assets-bob", code);
    const res = await fetch(`${baseUrl}/api/assets/folders`, {
        headers: { cookie: alice },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders: Folder[] };
    expect(body.folders.length).toBe(1);
    root = body.folders[0];
});

afterAll(async () => {
    await stopServer();
    await rm(tempDir, { recursive: true, force: true });
});

const folders = async (cookie: string, parent?: string) => {
    const url = `${baseUrl}/api/assets/folders${
        parent ? `?parent=${encodeURIComponent(parent)}` : ""
    }`;
    const res = await fetch(url, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders: Folder[] };
    return body.folders;
};

const allFolders = async (cookie: string): Promise<Folder[]> => {
    const res = await fetch(`${baseUrl}/api/assets/folders/all`, {
        headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders: Folder[] };
    return body.folders;
};

const files = async (cookie: string, folderId: string) => {
    const res = await fetch(
        `${baseUrl}/api/assets/files?folderId=${encodeURIComponent(folderId)}`,
        { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: AssetFile[] };
    return body.files;
};

const createFolder = async (cookie: string, parentId: string, name: string) => {
    const res = await fetch(`${baseUrl}/api/assets/folders`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ parentId, name }),
    });
    const body = (await res.json()) as { folder?: Folder; error?: string; code?: number };
    return { status: res.status, body };
};

const upload = async (
    cookie: string,
    folderId: string,
    name: string,
    data: string | Uint8Array,
    mimeType = "text/plain",
) => {
    // FormData's File type carries a `;charset=utf-8` suffix — the store
    // compares the mime type as stored, so keep the bare type here.
    const bareType = (mimeType || "").split(";")[0];
    const form = new FormData();
    form.append("folderId", folderId);
    const bytes =
        typeof data === "string" ? new TextEncoder().encode(data) : data;
    form.append("files", new File([bytes as BlobPart], name, { type: bareType }));
    const res = await fetch(`${baseUrl}/api/assets/files`, {
        method: "POST",
        headers: { cookie },
        body: form,
    });
    const body = (await res.json()) as { files?: AssetFile[]; error?: string; code?: number };
    return { status: res.status, body };
};

describe("assets auth", () => {
    test("rejects unauthenticated API requests", async () => {
        // The page is a static HTML shell (auth happens on the API); the
        // folder API must not answer before sign-in.
        const api = await fetch(`${baseUrl}/api/assets/folders`);
        expect(api.status).toBe(401);
        const page = await fetch(`${baseUrl}/assets/`);
        expect(page.status).toBe(200);
    });

    test("serves the assets page to an authenticated user", async () => {
        const res = await fetch(`${baseUrl}/assets/`, { headers: { cookie: alice } });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("assets_list");
    });
});

describe("assets folders", () => {
    test("each user starts with a single Root folder", async () => {
        expect(root.parentId).toBeNull();
        expect(root.name).toBe("Root");
        expect(typeof root.createdAt).toBe("number");
        const bobRoots = await folders(bob);
        expect(bobRoots.length).toBe(1);
        expect(bobRoots[0].id).not.toBe(root.id);
    });

    test("creates, renames and lists subfolders", async () => {
        const created = await createFolder(alice, root.id, "Docs");
        expect(created.status).toBe(200);
        expect(created.body.folder?.name).toBe("Docs");
        expect(created.body.folder?.parentId).toBe(root.id);

        const patch = await fetch(
            `${baseUrl}/api/assets/folders/${created.body.folder!.id}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json", cookie: alice },
                body: JSON.stringify({ name: "Reports" }),
            },
        );
        expect(patch.status).toBe(200);
        const patched = (await patch.json()) as { folder: Folder };
        expect(patched.folder.name).toBe("Reports");

        const kids = await folders(alice, root.id);
        expect(kids.map((f) => f.name)).toContain("Reports");
        // The parent now advertises children for the tree chevron.
        const refreshed = (await allFolders(alice)).find(
            (f) => f.id === root.id,
        );
        expect(refreshed?.hasChildren).toBe(true);
    });

    test("rejects duplicate names in the same parent and empty names", async () => {
        const dup = await createFolder(alice, root.id, "Reports");
        expect(dup.status).toBe(409);
        const empty = await createFolder(alice, root.id, "  ");
        expect(empty.status).toBe(400);
    });

    test("moves folders and rejects cycles and self-moves", async () => {
        const { body: a } = await createFolder(alice, root.id, "A");
        const { body: b } = await createFolder(alice, a.folder!.id, "B");
        // Move A into its own descendant B: cycle → 400.
        let res = await fetch(`${baseUrl}/api/assets/folders/${a.folder!.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", cookie: alice },
            body: JSON.stringify({ parentId: b.folder!.id }),
        });
        expect(res.status).toBe(400);
        // Moving a folder onto itself: 400 as well.
        res = await fetch(`${baseUrl}/api/assets/folders/${a.folder!.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", cookie: alice },
            body: JSON.stringify({ parentId: a.folder!.id }),
        });
        expect(res.status).toBe(400);
        // Move B back to the root: a legal move succeeds.
        res = await fetch(
            `${baseUrl}/api/assets/folders/${b.folder!.id}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json", cookie: alice },
                body: JSON.stringify({ parentId: root.id }),
            },
        );
        expect(res.status).toBe(200);
        const moved = (await res.json()) as { folder: Folder };
        expect(moved.folder.parentId).toBe(root.id);
    });

    test("caps folder depth (the root counts as level 1)", async () => {
        let parent = root;
        for (let i = 1; i <= 15; i++) {
            const { body } = await createFolder(
                alice,
                parent.id,
                `depth-${i}`,
            );
            expect(body.folder, `depth ${i} must be creatable`).toBeTruthy();
            parent = body.folder!;
        }
        // root + 15 levels = the 16th and last level; one more is refused.
        const { status, body } = await createFolder(
            alice,
            parent.id,
            "depth-16",
        );
        expect(status).toBe(400);
        expect(body.error).toMatch(/too deep/i);
    });

    test("deletes folders recursively (subfolders and files vanish)", async () => {
        const { body: parent } = await createFolder(alice, root.id, "Trash");
        const { body: child } = await createFolder(
            alice,
            parent.folder!.id,
            "Deeper",
        );
        const up = await upload(
            alice,
            child.folder!.id,
            "inside.txt",
            "gone soon",
        );
        expect(up.status).toBe(200);

        const res = await fetch(
            `${baseUrl}/api/assets/folders/${parent.folder!.id}`,
            { method: "DELETE", headers: { cookie: alice } },
        );
        expect(res.status).toBe(200);

        expect(
            (await folders(alice, root.id)).map((f) => f.name),
        ).not.toContain("Trash");
        const meta = await fetch(
            `${baseUrl}/api/assets/file-meta/${up.body.files![0].id}`,
            { headers: { cookie: alice } },
        );
        expect(meta.status).toBe(404);
    });
});

describe("assets files", () => {
    let folder: Folder;

    beforeAll(async () => {
        const { body } = await createFolder(alice, root.id, "Files");
        folder = body!.folder!;
    });

    test("uploads (auto-suffixed on collision) and lists files", async () => {
        const first = await upload(alice, folder.id, "a.txt", "hello");
        expect(first.status).toBe(200);
        expect(first.body.files![0].name).toBe("a.txt");
        expect(first.body.files![0].size).toBe(5);
        expect(first.body.files![0].mimeType).toBe("text/plain");

        // Same name again → "a (1).txt".
        const dup = await upload(alice, folder.id, "a.txt", "second");
        expect(dup.body.files![0].name).toBe("a (1).txt");

        const listed = await files(alice, folder.id);
        expect(listed.map((f) => f.name).sort()).toEqual(["a (1).txt", "a.txt"]);
    });

    test("exposes file metadata and downloads the exact bytes", async () => {
        const [file] = await files(alice, folder.id);
        const meta = await fetch(
            `${baseUrl}/api/assets/file-meta/${file.id}`,
            { headers: { cookie: alice } },
        );
        expect(meta.status).toBe(200);
        const metaBody = (await meta.json()) as { file: AssetFile };
        expect(metaBody.file.id).toBe(file.id);

        const res = await fetch(`${baseUrl}/api/assets/files/${file.id}`, {
            headers: { cookie: alice },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/plain");
        expect(res.headers.get("content-disposition")).toContain("attachment");
        expect(res.headers.get("content-disposition")).toContain(
            encodeURIComponent(file.name),
        );
        const bytes = new Uint8Array(await res.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        expect(text).toBe(file.name === "a.txt" ? "hello" : "second");
    });

    test("renames and moves files, rejecting colliding renames", async () => {
        const [a, aCopy] = await files(alice, folder.id);
        // Rename a → a (1).txt: collides → 409.
        let res = await fetch(`${baseUrl}/api/assets/files/${a.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", cookie: alice },
            body: JSON.stringify({ name: aCopy.name }),
        });
        expect(res.status).toBe(409);
        // Rename into a free name: ok.
        res = await fetch(`${baseUrl}/api/assets/files/${a.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", cookie: alice },
            body: JSON.stringify({ name: "renamed.txt" }),
        });
        expect(res.status).toBe(200);

        // Move into a subfolder.
        const { body: sub } = await createFolder(alice, folder.id, "Sub");
        res = await fetch(`${baseUrl}/api/assets/files/${a.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", cookie: alice },
            body: JSON.stringify({ folderId: sub!.folder!.id }),
        });
        expect(res.status).toBe(200);
        const moved = (await res.json()) as { file: AssetFile };
        expect(moved.file.folderId).toBe(sub!.folder!.id);
        expect(await files(alice, folder.id)).toHaveLength(1);
        expect(await files(alice, sub!.folder!.id)).toHaveLength(1);
    });

    test("deletes files", async () => {
        const [file] = await files(alice, folder.id);
        const res = await fetch(`${baseUrl}/api/assets/files/${file.id}`, {
            method: "DELETE",
            headers: { cookie: alice },
        });
        expect(res.status).toBe(200);
        const meta = await fetch(
            `${baseUrl}/api/assets/file-meta/${file.id}`,
            { headers: { cookie: alice } },
        );
        expect(meta.status).toBe(404);
    });

    test("ignores unknown patch bodies", async () => {
        const up = await upload(alice, folder.id, "t.txt", "x");
        const res = await fetch(
            `${baseUrl}/api/assets/files/${up.body.files![0].id}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json", cookie: alice },
                body: JSON.stringify({ nope: true }),
            },
        );
        expect(res.status).toBe(400);
    });
});

describe("assets storage directory", () => {
    test("saves uploaded bytes to the storage dir and removes them again", async () => {
        const up = await upload(alice, root.id, "disk.txt", "on disk", "text/plain");
        expect(up.status).toBe(200);
        const fileId = up.body.files![0].id;
        const diskPath = join(storagePath, fileId);
        expect(await existsSync(diskPath)).toBe(true);
        expect(new TextDecoder().decode(await readFile(diskPath))).toBe(
            "on disk",
        );

        const del = await fetch(`${baseUrl}/api/assets/files/${fileId}`, {
            method: "DELETE",
            headers: { cookie: alice },
        });
        expect(del.status).toBe(200);
        expect(await existsSync(diskPath)).toBe(false);
    });

    test("removes the disk files when a folder is deleted", async () => {
        const { body } = await createFolder(alice, root.id, "DiskTrash");
        const up = await upload(
            alice,
            body!.folder!.id,
            "vanish.bin",
            new Uint8Array([1, 2, 3]),
            "application/octet-stream",
        );
        expect(up.status).toBe(200);
        const diskPath = join(storagePath, up.body.files![0].id);
        expect(await existsSync(diskPath)).toBe(true);

        const del = await fetch(
            `${baseUrl}/api/assets/folders/${body!.folder!.id}`,
            { method: "DELETE", headers: { cookie: alice } },
        );
        expect(del.status).toBe(200);
        expect(await existsSync(diskPath)).toBe(false);
    });

    test("downloads keep serving from the storage dir", async () => {
        const up = await upload(alice, root.id, "serve.png", "png-bytes", "image/png");
        expect(up.status).toBe(200);
        const res = await fetch(
            `${baseUrl}/api/assets/files/${up.body.files![0].id}`,
            { headers: { cookie: alice } },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("png-bytes");
        // tidy up so the owner-isolation list stays predictable
        await fetch(`${baseUrl}/api/assets/files/${up.body.files![0].id}`, {
            method: "DELETE",
            headers: { cookie: alice },
        });
    });

    test("browse lists the media files of the whole tree with their path", async () => {
        const { body: imgDir } = await createFolder(alice, root.id, "Browsed");
        expect(imgDir.folder).toBeTruthy();
        const { body: imgSub } = await createFolder(
            alice,
            imgDir.folder!.id,
            "Pics",
        );
        expect(imgSub.folder).toBeTruthy();
        const img = await upload(alice, imgSub.folder!.id, "one.png", "img", "image/png");
        const vid = await upload(alice, imgDir.folder!.id, "clip.mp4", "vid", "video/mp4");
        const doc = await upload(alice, imgDir.folder!.id, "notes.txt", "doc", "text/plain");
        expect(img.status).toBe(200);
        expect(vid.status).toBe(200);
        expect(doc.status).toBe(200);

        const imagesRes = await fetch(`${baseUrl}/api/assets/browse?kind=image`, {
            headers: { cookie: alice },
        });
        expect(imagesRes.status).toBe(200);
        const images = (await imagesRes.json()) as {
            files: (AssetFile & { path: string })[];
        };
        const names = images.files
            .filter((f) => f.id === img.body.files![0].id)
            .map((f) => f.path);
        expect(names).toEqual(["Browsed/Pics"]);

        const videos = (
            (await (
                await fetch(`${baseUrl}/api/assets/browse?kind=video`, {
                    headers: { cookie: alice },
                })
            ).json()) as { files: (AssetFile & { path: string })[] }
        ).files;
        expect(
            videos.some((f) => f.id === vid.body.files![0].id),
        ).toBe(true);
        // text files are never in a media browse
        expect(
            images.files.some((f) => f.id === doc.body.files![0].id),
        ).toBe(false);
        expect(
            videos.some((f) => f.id === doc.body.files![0].id),
        ).toBe(false);

        const badKind = await fetch(`${baseUrl}/api/assets/browse?kind=pdf`, {
            headers: { cookie: alice },
        });
        expect(badKind.status).toBe(400);
    });
});

describe("assets owner isolation", () => {
    test("bob never sees or touches alice's assets", async () => {
        // bob's tree only has his own root.
        const all = await allFolders(bob);
        expect(all).toHaveLength(1);
        expect(all[0].id).not.toBe(root.id);

        // Reading alice's file meta / bytes: 404 (no existence leak).
        const res = await fetch(
            `${baseUrl}/api/assets/files/${root.id}`,
            { headers: { cookie: bob } },
        );
        expect([401, 404]).toContain(res.status);

        // Mutating alice's root folder: 404.
        const patch = await fetch(`${baseUrl}/api/assets/folders/${root.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", cookie: bob },
            body: JSON.stringify({ name: "hijacked" }),
        });
        expect(patch.status).toBe(404);

        // Listing alice's root folder contents: 404 (the folder isn't
        // bob's), never alice's files.
        const listed = await fetch(
            `${baseUrl}/api/assets/files?folderId=${encodeURIComponent(root.id)}`,
            { headers: { cookie: bob } },
        );
        expect(listed.status).toBe(404);
    });
});
