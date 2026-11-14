/*
 * Modems module: ModemManager integration — enumerate the modems, their
 * signal / operator / registration details, and the control actions
 * (enable / disable / connect / disconnect / reset). Serves the roles that
 * manage their uplinks through modems (relay, encoder, moblink_relay); the
 * network module enriches its interface list with `modems.source`.
 */

import type { BackendModule } from "../../../shared/contracts/backend_module";
import {
    ApiError,
    optionalApn,
    optionalBoolean,
    optionalPassword,
    optionalPlmn,
    optionalRat,
    optionalRatList,
    optionalUsername,
    requireIndex,
} from "../../../shared/params";
import type { ModuleCore } from "../../backend/module_core";
import log from "./log";
import {
    bindModemManager,
    detectModems,
    gsmProfile,
    modemSource,
    performModemAction,
    pruneOrphanGsmConns,
    scanMobileNetworks,
    setupModemNetwork,
    startModemAutodial,
    stopModemAutodial,
} from "./modems";
import type { ModemInfo, ModemNetworkSetup } from "./types";

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
    roles: ["relay", "encoder", "moblink_relay"],
    dependencies: [],
    methods: [
        "modems.list",
        "modems.enable",
        "modems.disable",
        "modems.reset",
        "modems.connect",
        "modems.disconnect",
        "modems.scan",
        "modems.profile",
        "modems.setup",
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
        // Clear stale gsm profiles (no device-id / sim-id) so old autoconnect
        // connections don't keep dialing behind the active one.
        void pruneOrphanGsmConns().catch((err: unknown) =>
            console.warn("[modems] orphan prune failed:", String(err)),
        );
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
            case "modems.scan": {
                const index = requireIndex(p);
                return { index, networks: await scanMobileNetworks(index) };
            }
            case "modems.profile": {
                const index = requireIndex(p);
                return { index, profile: (await gsmProfile(index)) ?? null };
            }
            case "modems.setup": {
                const index = requireIndex(p);
                const setup: ModemNetworkSetup = {
                    plmn: optionalPlmn(p),
                    operatorName:
                        typeof p.operatorName === "string"
                            ? p.operatorName
                            : undefined,
                    apn: optionalApn(p),
                    username: optionalUsername(p),
                    password: optionalPassword(p),
                    allowRoaming: optionalBoolean(p, "allowRoaming"),
                    autoConfig: optionalBoolean(p, "autoConfig"),
                    allowedModes: optionalRatList(p),
                    preferredMode: optionalRat(p),
                };
                const hasField = (
                    Object.keys(setup) as (keyof ModemNetworkSetup)[]
                )
                    .filter((key) => key !== "operatorName")
                    .some((key) => setup[key] !== undefined);
                if (!hasField)
                    throw new ApiError(
                        "at least one of plmn, apn, username, password, " +
                            "allowRoaming, autoConfig, allowedModes or " +
                            "preferredMode is required",
                    );
                const result = await setupModemNetwork(index, setup);
                return {
                    index,
                    ok: result.ok,
                    modes: result.modes,
                };
            }
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
