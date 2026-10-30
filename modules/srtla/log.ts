/** Log wording of the srtla module's methods (registered by both the backend and the frontend). */
import {
    type LogWording,
    logTranslate,
    wording,
} from "../../shared/logMessages";

const modemAction = (action: string, key: string) =>
    wording("Modems", action, (p) => logTranslate(key, { index: p.index }));

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
        "modems.enable": modemAction("Enable", "mlog.done.modem_enabled"),
        "modems.disable": modemAction("Disable", "mlog.done.modem_disabled"),
        "modems.connect": modemAction("Connect", "mlog.done.modem_connected"),
        "modems.disconnect": modemAction(
            "Disconnect",
            "mlog.done.modem_disconnected",
        ),
        "modems.reset": modemAction("Reset", "mlog.done.modem_reset"),
        "srtla.start": wording("SRTLA", "Start", "mlog.done.started"),
        "srtla.stop": wording("SRTLA", "Stop", "mlog.done.stopped"),
        "srtla.reload": wording("SRTLA", "Reload", "mlog.done.reloaded"),
        "srtla.options": wording("SRTLA", "Options update", (p) =>
            [
                p.mode !== undefined &&
                    logTranslate("mlog.done.mode", { mode: p.mode }),
                p.quality !== undefined &&
                    logTranslate(
                        p.quality
                            ? "mlog.done.quality_on"
                            : "mlog.done.quality_off",
                    ),
            ]
                .filter(Boolean)
                .join(", "),
        ),
    },
    sections: { srtla: "SRTLA", modems: "Modems", interfaces: "Interfaces" },
    labels: {
        SRTLA: "dev.card.srtla",
        Modems: "dev.card.modems",
        Interfaces: "dev.card.interfaces",
        "Options update": "mlog.action.options",
    },
};

export default log;
