import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { Window as HappyWindow } from "happy-dom";

type Role = "owner" | "editor" | "viewer";
type Token = { id: number; token: string; createdAt: string };
type ApiRequest = { path: string; method: string };

const existingToken: Token = {
    id: 1,
    token: "existing-device-token",
    createdAt: "2026-01-02T03:04:05.000Z",
};

let pageBundle = "";
let mountCount = 0;
let win: HappyWindow;
let requests: ApiRequest[];
let copied: string[];
let savedGlobals: [string, PropertyDescriptor | undefined][];

const globalKeys = [
    "window",
    "document",
    "navigator",
    "location",
    "HTMLElement",
    "Element",
    "Node",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "__projectsPageTestApi",
];

beforeAll(async () => {
    const result = await Bun.build({
        entrypoints: [
            new URL(
                "../server/pages/projects/frontend/projects_list.tsx",
                import.meta.url,
            ).pathname,
        ],
        target: "browser",
        format: "esm",
        loader: { ".css": "text" },
        plugins: [
            {
                name: "project-view-fixtures",
                setup(build) {
                    build.onLoad({ filter: /shared\/ui\/i18n\.tsx$/ }, () => ({
                        contents: `
                            export const i18nReady = Promise.resolve();
                            export const t = (key) => key;
                            export const LanguageSelect = { view: () => null };
                        `,
                        loader: "js",
                    }));
                    build.onLoad({ filter: /shared\/ui\/api_client\.ts$/ }, () => ({
                        contents: `
                            export const apiJson = (...args) => globalThis.__projectsPageTestApi(...args);
                            export const isUnauthorized = () => false;
                        `,
                        loader: "js",
                    }));
                    build.onLoad({ filter: /server\/shell\/nav\.tsx$/ }, () => ({
                        contents: "export const ServerNav = { view: () => null };",
                        loader: "js",
                    }));
                    build.onLoad(
                        { filter: /server\/shell\/project_select\.tsx$/ },
                        () => ({
                            contents: "export const setActiveProjectId = () => {};",
                            loader: "js",
                        }),
                    );
                },
            },
        ],
    });
    if (!result.success)
        throw new AggregateError(result.logs, "Failed to bundle the projects page");
    const script = result.outputs.find((output) => output.path.endsWith(".js"));
    if (!script) throw new Error("Projects page bundle did not contain JavaScript");
    pageBundle = await script.text();
});

beforeEach(async () => {
    const { Window } = await import("happy-dom");
    win = new Window({ url: "http://localhost/projects/" });
    win.document.body.innerHTML = '<div id="app"></div>';
    requests = [];
    copied = [];
    savedGlobals = globalKeys.map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
    ]);
    const values: Record<string, unknown> = {
        window: win,
        document: win.document,
        navigator: win.navigator,
        location: win.location,
        HTMLElement: win.HTMLElement,
        Element: win.Element,
        Node: win.Node,
        requestAnimationFrame: win.requestAnimationFrame.bind(win),
        cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    };
    for (const [key, value] of Object.entries(values))
        Object.defineProperty(globalThis, key, {
            configurable: true,
            writable: true,
            value,
        });
    Object.defineProperty(win.navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value: string) => void copied.push(value) },
    });
});

afterEach(async () => {
    try {
        await win.happyDOM.abort();
    } finally {
        for (const [key, descriptor] of savedGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline)
            throw new Error("Timed out waiting for the projects page");
        await Bun.sleep(5);
    }
}

function findCard(title: string) {
    return [...win.document.querySelectorAll("section.card")].find(
        (card) => card.querySelector("h2")?.textContent === title,
    );
}

function card(title: string) {
    const found = findCard(title);
    if (!found) throw new Error(`Missing card: ${title}`);
    return found;
}

async function mountPage(role: Role, tokens: Token[]): Promise<void> {
    Object.defineProperty(globalThis, "__projectsPageTestApi", {
        configurable: true,
        value: async (path: string, init?: { method?: string }) => {
            const method = init?.method ?? "GET";
            requests.push({ path, method });
            if (path === "/api/whoami") return { user: "test-user" };
            if (path === "/api/projects")
                return { projects: [{ id: "fixture", name: "Stream", role }] };
            if (path === "/api/projects/fixture/members")
                return { members: [{ userId: 1, login: "test-user", role }] };
            if (path === "/api/projects/fixture/invites")
                return {
                    invites: [{
                        id: "invite-1",
                        role: "viewer",
                        url: "https://example.test/projects/join/invite",
                        createdAt: existingToken.createdAt,
                        expiresAt: null,
                        usedBy: null,
                    }],
                };
            if (path === "/api/projects/fixture/tokens" && method === "GET")
                return { tokens };
            if (path === "/api/projects/fixture/tokens" && method === "POST")
                return {
                    token: {
                        id: 2,
                        token: "new-device-token",
                        createdAt: existingToken.createdAt,
                    },
                };
            if (path === "/api/projects/fixture/tokens/1" && method === "DELETE")
                return { ok: true };
            throw new Error(`Unexpected request: ${method} ${path}`);
        },
    });
    const source = `${pageBundle}\n// projects view fixture ${++mountCount}\n`;
    await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    await until(() => {
        const tokensCard = findCard("projects.tokens.title");
        return !!tokensCard && (
            tokens.length === 0
                ? tokensCard.textContent?.includes("projects.tokens.empty") === true
                : tokensCard.querySelector("tbody tr") !== null
        );
    });
}

describe("project device token list", () => {
    test("matches invitation tables and preserves copy, add and remove", async () => {
        await mountPage("owner", [existingToken]);
        await until(
            () => !!findCard("projects.invites.title")?.querySelector("tbody tr"),
        );
        const tokensCard = card("projects.tokens.title");
        const invitesCard = card("projects.invites.title");
        const tokenTable = tokensCard.querySelector("table");
        const inviteTable = invitesCard.querySelector("table");
        expect(tokenTable?.classList.contains("dash-table")).toBe(true);
        expect(inviteTable?.classList.contains("dash-table")).toBe(true);
        expect(tokenTable?.classList.contains("project-token-table")).toBe(true);
        expect(
            [...(tokenTable?.querySelectorAll("thead th") ?? [])].map(
                (heading) => heading.textContent,
            ),
        ).toEqual(["projects.tokens.value", "invitations.created", ""]);
        expect(tokenTable?.textContent).toContain(
            new Date(existingToken.createdAt).toLocaleString(),
        );
        expect(tokensCard.querySelector(".project-card-actions")?.className).toBe(
            invitesCard.querySelector(".project-card-actions")?.className,
        );
        expect(tokenTable?.querySelector("tbody button")?.className).toBe(
            inviteTable?.querySelector("tbody button")?.className,
        );
        expect(tokenTable?.querySelector("tbody td:last-child")?.className).toBe(
            inviteTable?.querySelector("tbody td:last-child")?.className,
        );

        const tokenValue = tokenTable?.querySelector("code");
        if (!tokenValue) throw new Error("Missing token value");
        tokenValue.click();
        await until(() => copied.length === 1);
        expect(copied).toEqual([existingToken.token]);

        const add = tokensCard.querySelector(".project-card-actions button");
        if (!(add instanceof win.HTMLButtonElement))
            throw new Error("Missing add token button");
        add.click();
        await until(() => tokensCard.textContent?.includes("new-device-token") === true);
        expect(requests).toContainEqual({
            path: "/api/projects/fixture/tokens",
            method: "POST",
        });

        const remove = tokenTable?.querySelector("tbody button");
        if (!(remove instanceof win.HTMLButtonElement))
            throw new Error("Missing remove token button");
        remove.click();
        await until(() => !tokensCard.textContent?.includes(existingToken.token));
        expect(requests).toContainEqual({
            path: "/api/projects/fixture/tokens/1",
            method: "DELETE",
        });
    });

    test("editors can manage tokens", async () => {
        await mountPage("editor", [existingToken]);
        const tokensCard = card("projects.tokens.title");
        expect(tokensCard.querySelector(".project-card-actions button")).not.toBeNull();
        expect(tokensCard.querySelector("tbody button")).not.toBeNull();
        expect(findCard("projects.invites.title")).toBeUndefined();
    });

    test("viewers can copy tokens but cannot manage them", async () => {
        await mountPage("viewer", [existingToken]);
        const tokensCard = card("projects.tokens.title");
        expect(tokensCard.querySelector(".project-card-actions")).toBeNull();
        expect(tokensCard.querySelector("tbody button")).toBeNull();
        const tokenValue = tokensCard.querySelector("code");
        if (!tokenValue) throw new Error("Missing token value");
        tokenValue.click();
        await until(() => copied.length === 1);
        expect(copied).toEqual([existingToken.token]);
    });

    test("keeps the empty state and add control", async () => {
        await mountPage("owner", []);
        const tokensCard = card("projects.tokens.title");
        expect(tokensCard.textContent).toContain("projects.tokens.empty");
        expect(tokensCard.querySelector("table")).toBeNull();
        expect(tokensCard.querySelector(".project-card-actions button")).not.toBeNull();
    });
});
