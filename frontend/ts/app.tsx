/* Device page — a Mithril view over the device store (device/store.ts): header, one card per
 * role-specific function, and the event log. The WebSocket client mutates state and redraws. */
import m from "mithril";
import { moduleCards } from "./module-registry";
import { gearIcon, roleTag } from "./components/icons";
import { Badge, Page, TitleWithBack } from "./components/ui";
import { LogCard } from "./device/log";
import { act, connectDevice, st } from "./device/store";
import { t } from "./i18n";
import { mountPage } from "./util";

// The store's websocket is lazy (surfaces like the dashboard import the store
// without a device to talk to): open it on the device page.
connectDevice();

function connBadge(): m.Vnode {
    if (!st.socketOpen)
        return <Badge text={t("dev.disconnected")} kind="off" />;
    if (st.device && !st.device.online)
        return <Badge text={t("dev.device_offline")} kind="warn" />;
    return <Badge text={t("dev.connected")} kind="on" />;
}

async function setAutostart(enabled: boolean): Promise<void> {
    const status = st.status;
    if (!status || st.autostartBusy) return;
    st.autostartBusy = true;
    const previous = status.state.autostart;
    status.state.autostart = enabled; // optimistic
    const result = await act<{ autostart: boolean }>(null, "autostart.set", {
        enabled,
    });
    st.autostartBusy = false;
    status.state.autostart = result ? result.autostart : previous;
    m.redraw();
}

function headerRight(): m.Children[] {
    const status = st.status;
    return [
        <label class={"check"} title={t("dev.autostart_title")}>
            <input
                type={"checkbox"}
                checked={status?.state.autostart ?? false}
                disabled={!status || st.autostartBusy}
                onchange={(e: Event) =>
                    void setAutostart((e.target as HTMLInputElement).checked)
                }
            />
            {` ${t("ui.autostart")}`}
        </label>,
        status && <span class={"badge"}>{roleTag(status.role)}</span>,
        connBadge(),
        <a
            class={"icon-link"}
            href={"settings/"}
            title={t("set.title")}
            aria-label={t("set.title")}>
            {gearIcon()}
        </a>,
    ];
}

const App: m.Component = {
    view: () => {
        const status = st.status;
        const children = status ? moduleCards(status) : [];
        return (
            <Page
                title={
                    <TitleWithBack
                        href={st.device ? "../../" : undefined}
                        backLabel={t("dev.all_devices_title")}>
                        {[
                            `${t("dev.title")} `,
                            st.device && (
                                <span class={"muted"}>
                                    {st.device.hostname || st.device.id}
                                </span>
                            ),
                        ]}
                    </TitleWithBack>
                }
                headerRight={headerRight()}>
                {children}
                <LogCard />
            </Page>
        );
    },
};

// Refresh relative times ("12s ago") and stats staleness without waiting for a push
setInterval(() => {
    if (st.status || st.events.size) m.redraw();
}, 5_000);

void mountPage(() => t("dev.title"), App);
