/*
 * Autostart: resume the last run of every module when the service starts,
 * retrying until it succeeds (capture cards, receivers or uplinks may not be
 * ready right after boot). Modules implement `resume()`; a hand-issued
 * start/stop calls `cancelAutostart()` through the core bag to take over.
 */
import { t } from "../../shared/i18n";
import { errorMessage } from "../../shared/util";
import { logEvent } from "./eventlog";
import { saveState, state } from "./state";

const RETRY_MS = 5_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export async function setAutostart(enabled: boolean): Promise<void> {
    state.autostart = enabled;
    if (!enabled) cancelAutostart();
    await saveState();
}

/** Stop a pending autostart retry. */
export function cancelAutostart(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
}

/** Run `resume` (true when something was resumed), retrying on failure while autostart stays on. */
export function runAutostart(resume: () => Promise<boolean>): void {
    if (!state.autostart) return;
    cancelAutostart();
    const attempt = async () => {
        retryTimer = null;
        try {
            if (await resume()) {
                console.log("Autostart complete");
                logEvent("info", "Autostart", t("log.stream_resumed"));
            } else {
                console.log(
                    "Autostart enabled, but no previous stream settings to resume",
                );
                logEvent("warn", "Autostart", t("log.no_stream_settings"));
            }
        } catch (err: unknown) {
            const msg = errorMessage(err);
            console.warn(
                `Autostart failed, retrying in ${RETRY_MS / 1000}s:`,
                msg,
            );
            logEvent(
                "warn",
                "Autostart",
                t("log.stream_start_retry", {
                    delay: RETRY_MS / 1000,
                    error: msg,
                }),
            );
            if (state.autostart)
                retryTimer = setTimeout(() => void attempt(), RETRY_MS);
        }
    };
    void attempt();
}
