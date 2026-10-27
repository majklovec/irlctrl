import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
    defaultModules,
    ensureModuleSlices,
    safeModules,
} from "../backend/client/modules";
import { state } from "../backend/client/state";
import { ALL_MODULES, allModules } from "../shared/registry";

/**
 * Registry order of the device modules: the registry's topological sort over
 * declared `dependencies` (srtla after modems, encoder after srtla), ids
 * visited alphabetically. A new start dependency shifts the positions.
 */
const DEVICE_ORDER = ["modems", "srtla", "encoder", "obs-controller", "ssh"];
/** The channel widget modules (device-independent dashboard widgets). */
const WIDGET_IDS = ["stats", "chat"];

/**
 * The frontend registry cannot be imported outside the browser graph (it
 * mounts the device store at module init), so its discovery is checked from
 * the files: every modules/<id>/frontend.tsx must default-export at least one
 * registration whose `id` matches its directory, and whose `kind` splits the
 * set into device cards (matching the backend registry) and widgets. A module
 * can register several (e.g. a device-card plus a dashboard widget) by
 * default-exporting an array of them — the registry flattens it.
 */
const modulesDir = join(import.meta.dir, "..", "modules");

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
    for (const dir of readdirSync(modulesDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const file = join(modulesDir, dir.name, "frontend.tsx");
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
        out.push({ dir: dir.name, registrations });
    }
    return out;
}

const ids = (): string[] => allModules().map((mod) => mod.id);

describe("module registries", () => {
    // The device modules are discovered from modules/*/backend.ts, the 4 of
    // them in the canonical dependency order (the registry's start order).
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
        // The modems card has no frontend of its own: the srtla module composes
        // it (interfaces table + modem panels), so it is the only backend device
        // id without a device-card frontend. Every other backend id must have
        // exactly one, and no extra card ids may exist.
        const cardIds = scanFrontends()
            .flatMap((fe) => fe.registrations)
            .filter((r) => r.kind === "device-card")
            .map((r) => r.id);
        const front = new Set(cardIds);
        const missing = DEVICE_ORDER.filter(
            (id) => !front.has(id) && id !== "modems",
        );
        const extra = [...front].filter((id) => !DEVICE_ORDER.includes(id));
        expect(missing).toEqual([]);
        expect(extra).toEqual([]);
        // The modems card renders through the srtla composite.
        const srtlaSrc = readFileSync(
            join(modulesDir, "srtla", "frontend.tsx"),
            "utf8",
        );
        expect(srtlaSrc).toContain("mod-modems");
        expect(srtlaSrc).toContain("interfacesCard");
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
            join(import.meta.dir, "..", "frontend", "ts", "module-registry.ts"),
            "utf8",
        );
        expect(src).not.toMatch(/from "\.\.\/modules\/[\w-]+\/frontend/);
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
            join(import.meta.dir, "..", "frontend", "ts", "settings.tsx"),
            "utf8",
        );
        expect(settings).not.toMatch(
            /from "\.\.\/\.\.\/modules\/[\w-]+\/settings/,
        );
        const framework = readFileSync(
            join(import.meta.dir, "..", "frontend", "ts", "modules.tsx"),
            "utf8",
        );
        expect(framework).not.toMatch(
            /from "\.\.\/\.\.\/modules\/[\w-]+\/settings/,
        );
        expect(framework).toMatch(
            /from "\.\.\/\.\.\/generated\/modules\.settings\*?"/,
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
        expect(src).not.toMatch(/from "\.\.\/modules\/[\w-]+\/backend/);
        expect(src).toMatch(/readdirSync\(MODULES_DIR\)/);
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

    /**
     * Core files may only discover frontend modules through the generated
     * manifest. Module-specific UI is provided through generic contributions.
     * The test itself sits at the project root, so it is not in scope and its
     * own expectations never trip the scan.
     */
    test("core (backend/ + frontend/ts/) names no module by id", () => {
        const moduleIds = new Set<string>();
        for (const dir of readdirSync(modulesDir, { withFileTypes: true }))
            if (dir.isDirectory()) moduleIds.add(dir.name);
        /** The generated frontend/backend manifests are the only sanctioned paths. */
        const allow = new Set<string>([".generated"]);
        const walk = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
                e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
            );
        const filesOf = (root: string): string[] =>
            walk(root).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
        const offenders: string[] = [];
        for (const root of [
            join(import.meta.dir, "..", "backend", "client"),
            join(import.meta.dir, "..", "backend", "server"),
            join(import.meta.dir, "..", "frontend", "ts"),
        ]) {
            for (const file of filesOf(root)) {
                readFileSync(file, "utf8")
                    .split("\n")
                    .forEach((line, i) => {
                        const m = line.match(
                            /(?:from\s+|require\()\s*["']([^"']+)["']/,
                        );
                        if (!m) return;
                        const spec = m[1];
                        const at = spec.indexOf("modules/");
                        if (at < 0) return;
                        const tail = `/${spec.slice(at)}`; // e.g. "/modules/encoder/frontend"
                        const seg = spec
                            .slice(at + "modules/".length)
                            .split("/")[0];
                        if (
                            [...allow].some(
                                (a) => tail.endsWith(a) || seg.startsWith("."),
                            )
                        )
                            return; // sanctioned doors
                        if (moduleIds.has(seg))
                            offenders.push(`${file}:${i + 1} → ${spec}`);
                    });
            }
        }
        expect(
            offenders,
            `core names module ids:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });

    test("core frontend pages compose module contributions without feature branches", () => {
        const readPage = (name: string) =>
            readFileSync(
                join(import.meta.dir, "..", "frontend", "ts", name),
                "utf8",
            );
        const app = readPage("app.tsx");
        const dashboard = readPage("dashboard.tsx");
        const setup = readPage("setup.tsx");
        const devices = readPage("devices.tsx");

        expect(app).not.toMatch(
            /moduleCard\(["'](encoder|srtla|obs-controller)/,
        );
        expect(app).not.toMatch(/status\.role\s*[!=]|status\.modules/);
        expect(dashboard).not.toMatch(/ROLE_WIDGET_TYPES|CARD_MODULE/);
        expect(dashboard).not.toMatch(
            /case ["'](encoder|srtla|relay|combined|obs)["']/,
        );
        expect(dashboard).not.toContain("modules/obs-controller");
        expect(setup).not.toMatch(
            /encoderHost|srtlaRemoteHost|setup\.step\.encoder/,
        );
        expect(devices).not.toMatch(/hasEncoder|\.encoder\b|\.srtla\b/);
    });

    test("device modules declare their frontend contributions", () => {
        const frontend = (id: string) =>
            readFileSync(join(modulesDir, id, "frontend.tsx"), "utf8");
        const encoder = frontend("encoder");
        const srtla = frontend("srtla");
        const obs = frontend("obs-controller");

        for (const source of [encoder, srtla]) {
            expect(source).toContain("available:");
            expect(source).toContain("dashboardWidgets:");
            expect(source).toContain("setupSteps:");
            expect(source).toContain("deviceSummaryColumns:");
        }
        expect(obs).toContain("available:");
        expect(obs).toContain("dashboardWidgets:");
        expect(obs).not.toContain("st.obs");
    });

    test("frontend modules do not import one another", () => {
        const moduleIds = new Set(
            readdirSync(modulesDir, { withFileTypes: true })
                .filter(
                    (entry) =>
                        entry.isDirectory() &&
                        existsSync(
                            join(modulesDir, entry.name, "frontend.tsx"),
                        ),
                )
                .map((entry) => entry.name),
        );
        const offenders: string[] = [];
        for (const id of moduleIds) {
            const source = readFileSync(
                join(modulesDir, id, "frontend.tsx"),
                "utf8",
            );
            source.split("\n").forEach((line, index) => {
                const specifier = line.match(/from\s+["']([^"']+)["']/)?.[1];
                const importedModule = specifier?.match(/^\.\.\/([^/]+)/)?.[1];
                if (
                    importedModule &&
                    importedModule !== id &&
                    moduleIds.has(importedModule)
                )
                    offenders.push(`${id}/frontend.tsx:${index + 1}`);
            });
        }
        expect(offenders).toEqual([]);
    });

    test("the encoder owns its dedicated pipeline editor page", () => {
        const modulePage = join(
            modulesDir,
            "encoder",
            "pages",
            "pipelineedit.html",
        );
        expect(existsSync(modulePage)).toBe(true);
        expect(readFileSync(modulePage, "utf8")).toContain(
            "../pipeline-editor.tsx",
        );
        expect(
            existsSync(
                join(
                    import.meta.dir,
                    "..",
                    "frontend",
                    "app",
                    "pipelineedit.html",
                ),
            ),
        ).toBe(false);
    });
});

// Role presets come from the registrations (`roles`, `enabledByDefault`): the
// bonding modules serve relay and combined, the encoder serves encoder and
// combined, the obs controller is opt-in everywhere.
describe("role presets from the registrations", () => {
    test("default modules follow the roles each module serves", () => {
        const on = (role: Parameters<typeof defaultModules>[0]) =>
            Object.entries(defaultModules(role))
                .filter(([, slice]) => slice.enabled)
                .map(([key]) => key)
                .sort();
        expect(on("relay")).toEqual(["modems", "relay", "ssh"]);
        expect(on("combined")).toEqual(["encoder", "modems", "relay", "ssh"]);
        expect(on("encoder")).toEqual(["encoder", "ssh"]);
        expect(on("obs")).toEqual([]);
    });

    test("a module's stored slice key follows its configKey", () => {
        const srtla = ALL_MODULES.find((m) => m.id === "srtla");
        expect(srtla?.configKey).toBe("relay");
        expect(defaultModules("relay")).toHaveProperty("relay");
        expect(defaultModules("relay")).not.toHaveProperty("srtla");
    });

    test("status view exposes the modems module flag", () => {
        const saved = state.settings.modules;
        try {
            state.settings.modules = defaultModules("relay");
            const view = safeModules() as { modems?: { enabled: boolean } };
            expect(view.modems).toEqual({ enabled: true });
        } finally {
            state.settings.modules = saved;
        }
    });

    test("ensureModuleSlices backfills new fields and keeps stored values", () => {
        const saved = state.settings.modules;
        const role = state.settings.role;
        try {
            state.settings.modules = {
                "obs-controller": {
                    enabled: true,
                    obsUrl: "ws://1.2.3.4:4455",
                },
            };
            const modules = ensureModuleSlices("relay");
            expect(modules["obs-controller"]).toMatchObject({
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
