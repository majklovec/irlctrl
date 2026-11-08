/** Log wording of the network module's methods (registered by both the backend and the frontend). */
import {
    type LogWording,
    logTranslate,
    wording,
} from "../../../shared/log_messages";

const log: LogWording = {
    methods: {
        "modems.select": wording(
            "Interfaces",
            "Bond selection",
            "mlog.done.bond_updated",
        ),
        "modems.toggle": wording("Interfaces", "Bond toggle", (p) =>
            logTranslate("mlog.done.bond_toggled", { iface: p.iface }),
        ),
        reconfigure: wording(
            "Interfaces",
            "Reconfigure",
            "mlog.done.reconfigured",
        ),
    },
    sections: { interfaces: "Interfaces" },
    labels: {
        Interfaces: "dev.card.interfaces",
    },
};

export default log;
