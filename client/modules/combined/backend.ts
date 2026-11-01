/*
 * combined module: owns the `combined` device role — one box that encodes
 * and relays (bonds) in a single service. It runs nothing itself; the relay
 * and encoder modules both serve the role and do the work, so this module
 * only contributes the role definition (and its translations) and orders
 * itself after both of them.
 */
import type { BackendModule } from "../../../shared/module_contract";
import type { ModuleCore } from "../../backend/module_core";

const registration: BackendModule<ModuleCore> = {
    kind: "device",
    id: "combined",
    title: "Combined",
    roleDefinitions: [
        {
            id: "combined",
            titleKey: "role.combined",
            taglineKey: "setup.role.combined_tag",
            order: 30,
            setupSelectable: true,
        },
    ],
    roles: ["combined"],
    dependencies: ["relay", "encoder"],
    methods: [],
    events: [],
    async start() {},
    async stop() {},
    async dispatch(method) {
        throw new Error(`unknown method ${method}`);
    },
};

export default registration;
