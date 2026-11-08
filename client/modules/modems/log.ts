/** Log wording of the modems module's methods (registered by both the backend and the frontend). */
import {
    type LogWording,
    logTranslate,
    wording,
} from "../../../shared/log_messages";

const modemAction = (action: string, key: string) =>
    wording("Modems", action, (p) => logTranslate(key, { index: p.index }));

const log: LogWording = {
    methods: {
        "modems.enable": modemAction("Enable", "mlog.done.modem_enabled"),
        "modems.disable": modemAction("Disable", "mlog.done.modem_disabled"),
        "modems.connect": modemAction("Connect", "mlog.done.modem_connected"),
        "modems.disconnect": modemAction(
            "Disconnect",
            "mlog.done.modem_disconnected",
        ),
        "modems.reset": modemAction("Reset", "mlog.done.modem_reset"),
    },
    sections: { modems: "Modems" },
    labels: {
        Modems: "dev.card.modems",
    },
};

export default log;
