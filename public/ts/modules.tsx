/**
 * Universal settings module framework.
 *
 * Each device module (encoder, obs-controller, ...) provides a
 * modules/<id>/settings.tsx that default-exports a ModuleDef owning its own
 * card body, visibility rules and configuration parameters. The framework
 * registers every def from the build-time manifest
 * (modules/.generated.settings.ts, one import per settings.tsx) — the core
 * names no module by id. It provides shared per-module state (busy flag,
 * status message), an RPC runner that routes errors into the module's status
 * line, and the Card shell.
 */
import m from "mithril";
import type { Settings, modulesView } from "../../public/types";
import type { RpcClient } from "./services/rpc";
import { errorMessage } from "../../src/util";
import { t } from "./i18n";
import { Card } from "./components/ui";
import SETTINGS_MANIFEST from "../../modules/.generated.settings";

/** Everything a module needs to render and act. */
export interface ModuleContext {
    rpc: RpcClient;
    /** The role currently being edited ("" = keep current). */
    role: string;
    settings: Settings;
    modules: modulesView;
    /** Status line rendered below the module's body. */
    message: string;
    /** True while one of the module's RPC calls is in flight. */
    busy: boolean;
    /** Set the module's status line. */
    note(message: string): void;
    /** Adopt the server's module list (e.g. after modules.configure). */
    setModules(modules: modulesView): void;
    /**
     * Run an RPC call: clears the status, tracks busy state, routes
     * errors into the status line and rethrows.
     */
    run<T>(call: () => Promise<T>): Promise<T>;
}

export interface ModuleDef {
    /** Module id, matches the server's modules list (e.g. "encoder"). */
    id: string;
    /** i18n key for the card title. */
    titleKey: string;
    /** Whether the card is shown for the current role/module state. */
    visible: (ctx: ModuleContext) => boolean;
    /** Card body: the module's own form fields and action buttons. */
    render: (ctx: ModuleContext) => m.Children;
    /** Re-seed the module's local state from fresh server data. */
    refresh?: (ctx: ModuleContext) => void;
}

interface moduleState {
    message: string;
    busy: boolean;
}

const registered: ModuleDef[] = [];
const states = new Map<string, moduleState>();

const device = {
    rpc: undefined as RpcClient | undefined,
    role: "" as string,
    settings: undefined as Settings | undefined,
    modules: {} as modulesView,
};

export function registerModule(def: ModuleDef): void {
    if (states.has(def.id)) {
        throw new Error(`Settings module "${def.id}" is already registered`);
    }
    states.set(def.id, { message: "", busy: false });
    registered.push(def);
}

/**
 * Register every settings card found in the build-time manifest (one static
 * import per modules/<id>/settings.tsx, emitted by scripts/gen-modules.ts).
 * The core names no module by id — adding a module with a settings.tsx
 * registers it here automatically (regeneration happens before the bundle).
 */
for (const def of SETTINGS_MANIFEST as unknown as ModuleDef[]) {
    if (def && typeof def.id === "string" && typeof def.render === "function")
        registerModule(def);
}

/** Bind the RPC client for all registered modules. */
export function bind(rpc: RpcClient): void {
    device.rpc = rpc;
}

/** Push fresh server data into the framework and refresh every module. */
export function refreshDevice(input: {
    settings: Settings;
    modules: modulesView;
    /** The draft role from the device settings form (live preview). */
    role: string;
}): void {
    device.settings = input.settings;
    device.modules = input.modules;
    device.role = input.role;
    for (const def of registered) {
        def.refresh?.(contextFor(def));
    }
    m.redraw();
}

export function setModules(modules: modulesView): void {
    device.modules = modules;
    m.redraw();
}

/** Update the draft role from the device settings form (live visibility). */
export function setDraftRole(role: string): void {
    device.role = role;
    m.redraw();
}

function stateFor(def: ModuleDef): moduleState {
    const st = states.get(def.id);
    if (st === undefined) {
        throw new Error(`No state for settings module "${def.id}"`);
    }
    return st;
}

function contextFor(def: ModuleDef): ModuleContext {
    const st = stateFor(def);
    const rpc = device.rpc;
    const settings = device.settings;
    if (rpc === undefined || settings === undefined) {
        throw new Error("Settings modules are not ready");
    }
    return {
        rpc,
        role: device.role,
        settings,
        modules: device.modules,
        message: st.message,
        busy: st.busy,
        note: (message: string) => {
            st.message = message;
            m.redraw();
        },
        setModules,
        run: (call) => runFor(st, call),
    };
}

async function runFor<T>(st: moduleState, call: () => Promise<T>): Promise<T> {
    st.busy = true;
    st.message = "";
    m.redraw();
    try {
        return await call();
    } catch (err) {
        st.message = errorMessage(err);
        throw err;
    } finally {
        st.busy = false;
        m.redraw();
    }
}

/** Cards for all visible modules, or [] before the first load. */
export function renderModuleCards(): Array<m.Vnode | null> {
    if (device.rpc === undefined || device.settings === undefined) {
        return [];
    }
    return registered.map((def) => {
        const ctx = contextFor(def);
        if (!def.visible(ctx)) {
            return null;
        }
        return (
            <Card title={t(def.titleKey)}>
                {def.render(ctx)}
                {ctx.message === "" ? null : (
                    <p class="muted" role="status">
                        {ctx.message}
                    </p>
                )}
            </Card>
        );
    });
}
