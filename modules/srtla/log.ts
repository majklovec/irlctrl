/** Log wording of the srtla module's methods (registered by both the backend and the frontend). */
import {
    type LogWording,
    logTranslate,
    wording,
} from "../../shared/logMessages";

const log: LogWording = {
    methods: {
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
    // The srtla card also issues the bonding methods (modems module): give their
    // browser-side failures a proper section too.
    sections: { srtla: "SRTLA", modems: "Modems", interfaces: "Interfaces" },
    labels: {
        SRTLA: "dev.card.srtla",
        Modems: "dev.card.modems",
        Interfaces: "dev.card.interfaces",
        "Options update": "mlog.action.options",
    },
};

export default log;
