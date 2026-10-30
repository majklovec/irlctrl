/** @jsx m */
import m from "mithril";
import { i18nReady, t } from "../../frontend/ts/i18n";
import chatModule, { chatFeed } from "./frontend";
import type { ChatOverlayState } from "./types";
import "./overlay.css";

const root = document.getElementById("app");
if (!root) throw new Error("Missing chat overlay root");

const token = new URLSearchParams(location.search).get("token") ?? "";
const endpoint = `/api${location.pathname}`;
let state: ChatOverlayState | undefined;
let error = false;
let stopped = false;
let timer: ReturnType<typeof setTimeout>;
const controller = new AbortController();

async function refresh(): Promise<void> {
    try {
        const response = await fetch(endpoint, {
            headers: { authorization: `Bearer ${token}` },
            cache: "no-store",
            credentials: "omit",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) {
            state = undefined;
            error = true;
            if (response.status === 401 || response.status === 404) stopped = true;
            throw new Error(`Chat overlay request failed: ${response.status}`);
        }
        state = await response.json() as ChatOverlayState;
        chatModule.onFrame?.("widget.snapshot", { chat: state.chat });
        error = false;
    } catch (cause) {
        if (controller.signal.aborted) return;
        console.error("[chat overlay]", cause);
        state = undefined;
        error = true;
    } finally {
        if (!controller.signal.aborted) {
            m.redraw();
            if (!stopped) timer = setTimeout(() => void refresh(), 1_000);
        }
    }
}

window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
});

await i18nReady;
m.mount(root, {
    view: () => error
        ? m("p.chat-overlay-error", { role: "alert" }, t("chat.overlay_error"))
        : state ? chatFeed(state.widget, false) : null,
});
void refresh();
