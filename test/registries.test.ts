import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
    defaultModules,
    ensureModuleSlices,
    safeModules,
} from "../client/backend/modules";
import { state } from "../client/backend/state";
import { MODULE_ROOTS } from "../shared/paths";
import {
    ALL_MODULES,
    allModules,
    defaultRole,
    isRegisteredRole,
    registeredRoleIds,
    roleDefinitions,
} from "../shared/registry";

/**
 * Registry order of the device modules: the registry's topological sort over
 * declared `dependencies` (encoder after relay, combined after both), ids
 * visited alphabetically.
 * Independent modules precede that chain.
 */
const DEVICE_ORDER = [
    "broadcaster",
    "relay",
    "encoder",
    "combined",
    "obs",
    "ssh",
];
/** The channel widget modules (device-independent dashboard widgets). */
const WIDGET_IDS = ["stats", "chat"];

/**
 * The frontend registry cannot be imported outside the browser graph (it
 * mounts the device store at module init), so its discovery is checked from
 * the files: every <root>/<id>/frontend.tsx must default-export at least one
 * registration whose `id` matches its directory, and whose `kind` splits the
 * set into device cards (matching the backend registry) and widgets. A module
 * can register several (e.g. a device-card plus a dashboard widget) by
 * default-exporting an array of them — the registry flattens it.
 */
const appDir = join(import.meta.dir, "..");
/** Every module directory across the module roots (client/modules, server/modules). */
const moduleDirs = (): { id: string; path: string }[] =>
    MODULE_ROOTS.flatMap((root) =>
        readdirSync(join(appDir, root), { withFileTypes: true })
            .filter((dir) => dir.isDirectory())
            .map((dir) => ({ id: dir.name, path: join(appDir, root, dir.name) })),
    );
const moduleDir = (id: string): string => {
    const found = moduleDirs().find((dir) => dir.id === id);
    if (!found) throw new Error(`no module directory for ${id}`);
    return found.path;
};

/** The id/kind of the object a `const` declares (empty when it is not one). */
function regOf(src: string, name: string): { id?: string; kind?: string } {
    const decl = src.match(new RegExp(`const ${name}[\\s\\S]*?=\\s*`));
    if (!decl) return {};
    const body = src.slice((decl.index ?? 0) + decl[0].length);
    const id = body.match(/\bid:\s*"([^"]+)"/)?.[1];
    const kind = body.match(/\bkind:\s*"([^"]+)"/)?.[1];
    return id && kind ? { id, kind } : {};
}

function scanFrontends(): {
    dir: string;
    registrations: { id: string; kind: string }[];
}[] {
    const out: {
        dir: string;
        registrations: { id: string; kind: string }[];
    }[] = [];
    for (const dir of moduleDirs()) {
        const file = join(dir.path, "frontend.tsx");
        let src: string;
        try {
            src = readFileSync(file, "utf8");
        } catch {
            continue; // module without a frontend (backend-only) — fine
        }
        expect(
            src,
            `${dir}/frontend.tsx has no default export` as string,
        ).toContain("export default");
        // The exported id/kind are read from the object(s) the file
        // default-exports, not the whole file (helper literals like
        // `kind: "text"` must not win). Handle `export default <obj>` and
        // `export default [<obj>, <obj>, …]` (a module registering several).
        const arr = src.match(/export default\s*\[([^\]]*)\]/);
        const single = src.match(/export default\s*(\w+)/);
        const names = (arr ? arr[1] : single?.[1] ?? "")
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean);
        const registrations: { id: string; kind: string }[] = [];
        for (const name of names) {
            const reg = regOf(src, name);
            if (reg.id && reg.kind)
                registrations.push({ id: reg.id, kind: reg.kind });
        }
        expect(
            registrations.length,
            `${dir}/frontend.tsx default-exports no registration` as string,
        ).toBeGreaterThan(0);
        out.push({ dir: dir.id, registrations });
    }
    return out;
}

const ids = (): string[] => allModules().map((mod) => mod.id);

describe("module registries", () => {
    // The device modules are discovered from <root>/*/backend.ts in the
    // canonical dependency order (the registry's start order).
    test("backend registry enumerates the device modules in order", () => {
        const deviceIds = ids().filter((id) => DEVICE_ORDER.includes(id));
        expect(deviceIds).toEqual(DEVICE_ORDER);
    });

    test("backend registry discovers every widget module", () => {
        const all = ids();
        for (const id of WIDGET_IDS)
            expect(all, `missing widget ${id}` as string).toContain(id);
    });

    test("no duplicate module ids", () => {
        const all = ids();
        expect(new Set(all).size).toBe(all.length);
    });

    test("roles are contributed uniquely by modules with one default", () => {
        const definitions = roleDefinitions();
        const roleIds = definitions.map((definition) => definition.id);
        expect(new Set(roleIds).size).toBe(roleIds.length);
        expect(registeredRoleIds()).toEqual(roleIds);
        expect(definitions.filter((definition) => definition.default)).toEqual([
            expect.objectContaining({ id: defaultRole() }),
        ]);
        for (const module of ALL_MODULES)
            for (const role of module.roles ?? [])
                expect(isRegisteredRole(role)).toBe(true);
    });

    test("frontend discovery: directory name matches a registration id", () => {
        for (const fe of scanFrontends()) {
            // The module's own id (its directory) must be one of the ids it registers.
            expect(
                fe.registrations.map((r) => r.id),
                `${fe.dir}/frontend.tsx doesn't register ${fe.dir}`,
            ).toContain(fe.dir);
        }
    });

    test("device-card frontends cover every backend device-module id", () => {
        // A module without a frontend.tsx (ssh lives on the settings page) or
        // with only a card-less `contributions` registration (combined owns a
        // role, nothing to show) has no card by design. Every other backend id
        // must have exactly one card, and no extra card ids may exist.
        const fronts = scanFrontends();
        const cardIds = fronts
            .flatMap((fe) => fe.registrations)
            .filter((r) => r.kind === "device-card")
            .map((r) => r.id);
        const front = new Set(cardIds);
        const expectsCard = new Set(
            fronts
                .filter((fe) => fe.registrations.some((r) => r.kind !== "contributions"))
                .map((fe) => fe.dir),
        );
        const missing = DEVICE_ORDER.filter(
            (id) => !front.has(id) && expectsCard.has(id),
        );
        const extra = [...front].filter(
            (id) => !DEVICE_ORDER.includes(id),
        );
        expect(missing).toEqual([]);
        expect(extra).toEqual([]);
        // The relay card composes the routing table and modem panels.
        const relaySrc = readFileSync(
            join(moduleDir("relay"), "frontend.tsx"),
            "utf8",
        );
        expect(relaySrc).toContain("mod-relay-modems");
        expect(relaySrc).toContain("interfacesCard");
    });

    test("widget frontends are separate from device modules", () => {
        const f = scanFrontends();
        const backendDeviceIds = new Set(DEVICE_ORDER);
        const widgetIds = f
            .flatMap((fe) => fe.registrations)
            .filter((r) => r.kind === "widget")
            .map((r) => r.id);
        expect(widgetIds.length).toBeGreaterThanOrEqual(2);
        expect(widgetIds.filter((id) => backendDeviceIds.has(id)).length).toBe(
            0,
        );
    });

    test("frontend registry discovers via the generated manifest (no per-module imports, no Glob)", () => {
        const src = readFileSync(
            join(appDir, "shared", "ui", "module_registry.ts"),
            "utf8",
        );
        expect(src).not.toMatch(/modules\/[\w-]+\/frontend/);
        expect(src).not.toMatch(
            /import\.meta\.glob|Bun\.Glob|from "bun\/glob"|modules\/\*\/frontend/,
        );
        expect(src).toMatch(
            /from "\.\.\/\.\.\/generated\/modules\.frontend\*?";/,
        );
        const manifest = join(
            import.meta.dir,
            "..",
            "generated",
            "modules.frontend.ts",
        );
        expect(statSync(manifest).size).toBeGreaterThan(0);
        expect(readFileSync(manifest, "utf8")).toMatch(/AUTO-GENERATED/i);
    });

    test("settings framework discovers via the generated manifest (no per-module imports)", () => {
        const settings = readFileSync(
            join(appDir, "client", "frontend", "ts", "settings.tsx"),
            "utf8",
        );
        expect(settings).not.toMatch(/modules\/[\w-]+\/settings/);
        const framework = readFileSync(
            join(appDir, "client", "frontend", "ts", "modules.tsx"),
            "utf8",
        );
        expect(framework).not.toMatch(/modules\/[\w-]+\/settings/);
        expect(framework).toMatch(
            /from "(\.\.\/)+generated\/modules\.settings\*?"/,
        );
        const manifest = join(
            import.meta.dir,
            "..",
            "generated",
            "modules.settings.ts",
        );
        expect(statSync(manifest).size).toBeGreaterThan(0);
        expect(readFileSync(manifest, "utf8")).toMatch(/AUTO-GENERATED/i);
    });

    test("backend registry discovers by directory scan + compiled-binary manifest, no per-module imports", () => {
        const src = readFileSync(
            join(import.meta.dir, "..", "shared", "registry.ts"),
            "utf8",
        );
        expect(src).not.toMatch(/modules\/[\w-]+\/backend/);
        expect(src).toMatch(/for \(const root of MODULE_ROOTS\)/);
        // Compiled binaries (bun build --compile) cannot run the scan — they
        // fall back to the generated manifest, like the frontend registry.
        expect(src).toMatch(/"\.\.\/generated\/modules\.backend"/);
        const manifest = join(
            import.meta.dir,
            "..",
            "generated",
            "modules.backend.ts",
        );
        expect(statSync(manifest).size).toBeGreaterThan(0);
        expect(readFileSync(manifest, "utf8")).toMatch(/AUTO-GENERATED/i);
    });

    // The import-graph boundary (core never imports a module, modules never
    // import each other, client/server only meet through shared/) is pinned
    // by test/boundaries.test.ts.

    test("core frontend pages compose module contributions without feature branches", () => {
        const readPage = (side: "client" | "server", name: string) =>
            readFileSync(join(appDir, side, "frontend", "ts", name), "utf8");
        const app = readPage("client", "app.tsx");
        const dashboard = readPage("server", "dashboard.tsx");
        const setup = readPage("client", "setup.tsx");
        const devices = readPage("server", "devices.tsx");

        expect(app).not.toMatch(
            /moduleCard\(["'](encoder|relay|obs)/,
        );
        expect(app).not.toMatch(/status\.role\s*[!=]|status\.modules/);
        expect(dashboard).not.toMatch(/ROLE_WIDGET_TYPES|CARD_MODULE/);
        expect(dashboard).not.toMatch(
            /case ["'](encoder|srtla|relay|combined|obs)["']/,
        );
        expect(dashboard).not.toContain("modules/obs");
        expect(setup).not.toMatch(
            /encoderHost|srtlaRemoteHost|setup\.step\.encoder/,
        );
        expect(devices).not.toMatch(/hasEncoder|\.encoder\b|\.relay\b/);
    });

    test("device modules declare their frontend contributions", () => {
        const frontend = (id: string) =>
            readFileSync(join(moduleDir(id), "frontend.tsx"), "utf8");
        const encoder = frontend("encoder");
        const relay = frontend("relay");
        const obs = frontend("obs");

        for (const source of [encoder, relay]) {
            expect(source).toContain("available:");
            expect(source).toContain("dashboardWidgets:");
            expect(source).toContain("setupSteps:");
            expect(source).toContain("deviceSummaryColumns:");
        }
        expect(obs).toContain("available:");
        expect(obs).toContain("dashboardWidgets:");
        expect(obs).not.toContain("st.obs");
    });

    // "frontend modules do not import one another" is covered by
    // test/boundaries.test.ts ("a module never imports another module").

    test("the encoder owns its dedicated pipeline editor page", () => {
        const modulePage = join(moduleDir("encoder"), "pages", "pipelineedit.html");
        expect(existsSync(modulePage)).toBe(true);
        expect(readFileSync(modulePage, "utf8")).toContain(
            "../pipeline_editor.tsx",
        );
        expect(
            existsSync(join(appDir, "client", "frontend", "pages", "pipelineedit.html")),
        ).toBe(false);
    });
});

// Role presets come from module registrations: the bonding modules serve
// relay and combined, the encoder serves encoder and combined, the OBS
// controller defaults on for the dedicated OBS role and remains opt-in elsewhere.
describe("role presets from the registrations", () => {
    test("default modules follow the roles each module serves", () => {
        const on = (role: Parameters<typeof defaultModules>[0]) =>
            Object.entries(defaultModules(role))
                .filter(([, slice]) => slice.enabled)
                .map(([key]) => key)
                .sort();
        expect(on("relay")).toEqual(["relay", "ssh"]);
        expect(on("combined")).toEqual(["combined", "encoder", "relay", "ssh"]);
        expect(on("encoder")).toEqual(["encoder", "ssh"]);
        expect(on("obs")).toEqual(["obs"]);
    });

    test("a module's stored slice key is its id unless it declares a configKey", () => {
        const relay = ALL_MODULES.find((m) => m.id === "relay");
        expect(relay?.configKey).toBeUndefined();
        expect(defaultModules("relay")).toHaveProperty("relay");
        expect(defaultModules("relay")).not.toHaveProperty("srtla");
    });

    test("status view exposes the relay module flag", () => {
        const saved = state.settings.modules;
        try {
            state.settings.modules = defaultModules("relay");
            const view = safeModules() as { relay?: { enabled: boolean } };
            expect(view.relay).toEqual({ enabled: true });
        } finally {
            state.settings.modules = saved;
        }
    });

    test("ensureModuleSlices backfills new fields and keeps stored values", () => {
        const saved = state.settings.modules;
        const role = state.settings.role;
        try {
            state.settings.modules = {
                "obs": {
                    enabled: true,
                    obsUrl: "ws://1.2.3.4:4455",
                },
            };
            const modules = ensureModuleSlices("relay");
            expect(modules["obs"]).toMatchObject({
                enabled: true,
                obsUrl: "ws://1.2.3.4:4455",
                sceneEvents: true,
            });
            expect(modules.relay).toEqual({ enabled: true });
            expect(modules.encoder).toEqual({ enabled: false });
        } finally {
            state.settings.modules = saved;
            state.settings.role = role;
        }
    });
});
