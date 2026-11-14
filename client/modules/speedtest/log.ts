/** Log wording of the speedtest module's methods (both the backend and the frontend register it). */
import {
    type LogWording,
    logTranslate,
    wording,
} from "../../../shared/log_messages";

const log: LogWording = {
    methods: {
        "speedtest.run": wording(
            "Speedtest",
            "Run",
            (p) =>
                logTranslate("speedtest.log.started", {
                    server: p.serverId !== null && p.serverId !== undefined
                        ? String(p.serverId)
                        : "auto",
                    interface:
                        p.interface !== null && p.interface !== undefined
                            ? String(p.interface)
                            : "auto",
                }),
        ),
        "speedtest.cancel": wording("Speedtest", "Cancel", () =>
            logTranslate("speedtest.log.cancelled"),
        ),
    },
    sections: { speedtest: "Speedtest" },
    labels: {
        Speedtest: "dev.card.speedtest",
    },
};

export default log;
