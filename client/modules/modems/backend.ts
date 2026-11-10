/*
 * Modems module: ModemManager integration — enumerate the modems, their
 * signal / operator / registration details, and the control actions
 * (enable / disable / connect / disconnect / reset). Serves the roles that
 * manage their uplinks through modems (relay, encoder); the network module
 * enriches its interface list with `modems.source`.
 */
import type { ModuleCore } from "../../backend/module_core";
import type {
    BackendModule,
    Params,
} from "../../../shared/contracts/backend_module";
import { ApiError, requireIndex } from "../../../shared/params";
import log from "./log";
import {
    bindModemManager,
    detectModems,
    modemSource,
    performModemAction,
    startModemAutodial,
    stopModemAutodial,
} from "./modems";
import type { ModemInfo } from "./types";

let core: ModuleCore;

const modemStatus = async (): Promise<ModemInfo[]> => detectModems();

const MODEM_ACTIONS = [
    "enable",
    "disable",
    "connect",
    "disconnect",
    "reset",
] as const;

const registration: BackendModule<ModuleCore> = {
    kind: "device",
    id: "modems",
    title: "Modems",
    roles: ["relay", "encoder"],
    dependencies: [],
    methods: [
        "modems.list",
        "modems.enable",
        "modems.disable",
        "modems.reset",
        "modems.connect",
        "modems.disconnect",
    ],
    events: [],
    log,
    bind(c) {
        core = c;
        bindModemManager(c);
    },
    async start(ctx) {
        core = ctx.core;
        bindModemManager(core);
        // Keep every registered modem on the network: a persistent NM gsm
        // autoconnect profile dials on boot, and this re-dials on drop.
        startModemAutodial();
    },
    async stop() {
        stopModemAutodial();
    },
    async dispatch(method, p) {
        switch (method) {
            case "modems.list":
                return { modems: await modemStatus() };
            default: {
                const action = method.slice("modems.".length);
                if (!(MODEM_ACTIONS as readonly string[]).includes(action))
                    throw new ApiError(`Unknown method: ${method}`, 404);
                const index = requireIndex(p);
                return {
                    modemIndex: index,
                    action,
                    ok: await performModemAction(action, index),
                };
            }
        }
    },
    async status() {
        return { modems: await modemStatus() };
    },
    /** Device-bound dashboard widgets the module renders. */
    dashboardWidgets: [{ type: "modems", defaultSize: { w: 4, h: 4 } }],
    services: { capabilities: { "modems.source": modemSource } },
};

export default registration;
