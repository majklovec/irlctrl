/* SRTLA card: srtla_send state, the receiver form and the scheduler options.
 * The SRTLA module is the relay device's single card: it composes the interfaces
 * table (with the live SRTLA link stats) and the modem panels (merged in from
 * the modems module), so the device page and the dashboard widgets show the
 * same content. */
import "./styles.css";
import m from "mithril";
import type { ModemInfo, SrtlaLinkStats, Status } from "../../public/types";
import {
    Actions,
    Badge,
    Break,
    Button,
    Card,
    type Child,
    CheckField,
    DefinitionList,
    Field,
    FieldGroup,
    Form,
    Input,
    Options,
} from "../../public/ts/components/ui";
import { formatBitrate, formatSpeed, since } from "../../public/ts/util";
import { t } from "../../public/ts/i18n";
import { card, type DeviceCard } from "../../public/ts/device/store";
import { encoderStart, streamButtons } from "../encoder/frontend";
import type { BridgedModule } from "./types";

type SrtlaOptions = Status["state"]["srtlaOptions"];

function srtlaStart(host: DeviceCard): void {
    const { fields } = host;
    if (!fields.listenPort || !fields.remoteHost || !fields.remotePort) return;
    host.press("srtla-start", "srtla.start", {
        listenPort: fields.listenPort,
        remoteHost: fields.remoteHost,
        remotePort: fields.remotePort,
    });
}

async function setOption(
    host: DeviceCard,
    key: keyof SrtlaOptions,
    value: string | boolean,
): Promise<void> {
    const result = await host.act<{ options: SrtlaOptions }>(
        `srtla-${key}`,
        "srtla.options",
        { [key]: value },
    );
    // The status push is debounced; do not flash the old value until it arrives
    if (result && host.st.status)
        host.st.status.state.srtlaOptions = result.options;
}

// Scheduler options: the saved settings, else what the running srtla_send reports, else its defaults
const liveStats = (host: DeviceCard) =>
    host.st.status?.state.srtla.running ? host.st.stats : null;
const modeValue = (host: DeviceCard): string =>
    host.st.status?.state.srtlaOptions?.mode ??
    liveStats(host)?.mode ??
    "enhanced";
const qualityValue = (host: DeviceCard): boolean =>
    host.st.status?.state.srtlaOptions?.quality ??
    liveStats(host)?.quality_enabled ??
    true;

function controlBadge(status: Status): Child {
    const c = status.srtlaControl;
    if (c?.connected) return <Badge text={t("dev.connected")} kind={"on"} />;
    if (c?.supported)
        return <Badge text={t("dev.control_connecting")} kind={"warn"} />;
    return (
        <span class={"muted"} title={t("dev.control_unavailable_title")}>
            {t("dev.control_unavailable")}
        </span>
    );
}

export function srtlaCardBody(host: DeviceCard, status: Status): m.Vnode {
    const { fields, busy } = host;
    const s = status.state.srtla;
    const combined = status.role === "combined";
    return (
        <Card title={t("dev.card.srtla")} class={"mod-srtla"}>
            <DefinitionList
                rows={[
                    [
                        t("dev.row.state"),
                        s.running ? (
                            <Badge
                                text={t("dev.row_state_running")}
                                kind={"on"}
                            />
                        ) : (
                            <Badge text={t("dev.badge.stopped")} kind={"off"} />
                        ),
                    ],
                    [
                        t("dev.row.started"),
                        s.running ? since(s.startedAt) : null,
                    ],
                    [
                        t("dev.reloads"),
                        t(
                            "dev.reloads_detail",
                            {
                                reloads: s.reloadCount ?? 0,
                                last: since(s.lastReloadAt),
                                mode: status.monitor.reloadMode,
                            },
                        ),
                    ],
                    [
                        t("dev.monitor"),
                        status.monitor.running ? (
                            <Badge
                                text={t("dev.monitor_watching")}
                                kind={"on"}
                            />
                        ) : (
                            <Badge text={t("ui.off")} kind={"warn"} />
                        ),
                    ],
                    [t("dev.control"), s.running ? controlBadge(status) : null],
                ]}
            />
            <Form
                onSubmit={
                    combined ? () => encoderStart(host) : () => srtlaStart(host)
                }>
                <FieldGroup legend={t("dev.group.connection")}>
                    {!combined && (
                        <>
                            <Field
                                label={t("dev.field.srt_listen_port")}
                                control={
                                    <Input
                                        target={fields}
                                        prop="listenPort"
                                        placeholder={"6000"}
                                        required={true}
                                    />
                                }
                            />
                            <span> ⇨ </span>
                        </>
                    )}
                    <Field
                        label={t("dev.field.remote_host")}
                        control={
                            <Input
                                target={fields}
                                prop="remoteHost"
                                placeholder={"rec.example.com"}
                                required={true}
                            />
                        }
                    />
                    <Field
                        label={t("dev.field.remote_port")}
                        control={
                            <Input
                                target={fields}
                                prop="remotePort"
                                placeholder={"5000"}
                                required={true}
                            />
                        }
                    />
                </FieldGroup>
                <FieldGroup legend={t("dev.quality_scoring")}>
                    <Field
                        label={t("dev.scheduler")}
                        control={
                            <select
                                disabled={busy.has("srtla-mode")}
                                value={modeValue(host)}
                                onchange={(e: Event) =>
                                    void setOption(
                                        host,
                                        "mode",
                                        (e.target as HTMLSelectElement).value,
                                    )
                                }>
                                <Options
                                    pairs={[
                                        [
                                            "enhanced",
                                            t("dev.scheduler_enhanced"),
                                        ],
                                        ["classic", t("dev.scheduler_classic")],
                                    ]}
                                />
                            </select>
                        }
                    />
                    <CheckField
                        label={t("dev.quality_scoring")}
                        title={t("dev.quality_scoring_title")}
                        control={
                            <input
                                type={"checkbox"}
                                checked={qualityValue(host)}
                                disabled={
                                    busy.has("srtla-quality") ||
                                    modeValue(host) === "classic"
                                }
                                onchange={(e: Event) =>
                                    void setOption(
                                        host,
                                        "quality",
                                        (e.target as HTMLInputElement).checked,
                                    )
                                }
                            />
                        }
                    />
                </FieldGroup>
                <Break />
                {combined ? (
                    streamButtons(host, "stream.stop")
                ) : (
                    <Actions>
                        <Button
                            label={t("ui.start")}
                            type={"submit"}
                            disabled={!host.enabled("srtla-start")}
                        />
                        <Button
                            label={t("ui.stop")}
                            class={"danger"}
                            disabled={!host.enabled("srtla-stop")}
                            onclick={() =>
                                host.press("srtla-stop", "srtla.stop")
                            }
                        />
                        <Button
                            label={t("ui.reload")}
                            disabled={!host.enabled("srtla-reload")}
                            onclick={() =>
                                host.press("srtla-reload", "srtla.reload")
                            }
                        />
                    </Actions>
                )}
            </Form>
        </Card>
    );
}

// -------------------------------------------------------------- interfaces card

/* Interfaces: bond selection per interface, with the live srtla_send link
 * stats matched to interfaces by source IP (the `no-stats` class shows muted
 * placeholders until the first `srtla.stats` push). */
const STATS_STALE_MS = 5_000;
const LINK_COLUMNS = 7;

/** Signal-quality meter with its percentage. */
function signal(quality?: number): Child {
    if (quality === undefined) return "—";
    return (
        <span>
            <meter
                min={0}
                max={100}
                low={30}
                high={60}
                optimum={100}
                value={quality}
            />
            {` ${quality}%`}
        </span>
    );
}

function linkState(l: SrtlaLinkStats): m.Vnode {
    if (l.timed_out) return <Badge text={t("dev.link_timed_out")} kind="off" />;
    if (!l.connected)
        return <Badge text={t("dev.control_connecting")} kind="warn" />;
    if (l.stall_gated)
        return <Badge text={t("dev.link_stalled")} kind="warn" />;
    if (l.weak)
        return (
            <span title={l.weak_reason ?? ""}>
                <Badge text={t("dev.link_weak")} kind="warn" />
            </span>
        );
    return (
        <Badge
            text={l.sole_carrier ? t("dev.link_sole") : t("dev.link_up")}
            kind="on"
        />
    );
}

function linkCells(l: SrtlaLinkStats | undefined, total: number): m.Vnode[] {
    const cell = (child: Child, cls = "", title?: string): m.Vnode => (
        <td class={`link-col ${cls}`.trim()} title={title}>
            {child}
        </td>
    );
    if (!l)
        return Array.from({ length: LINK_COLUMNS }, () => cell("—", "muted"));
    const share = total ? l.bitrate_bytes_per_sec / total : 0;
    return [
        cell(linkState(l), "", l.label ?? ""),
        cell(
            <span>
                <meter
                    class={"share"}
                    min={0}
                    max={1}
                    value={share}
                    title={t(
                        "dev.link_share_title",
                        {
                            percentage: Math.round(share * 100),
                            rtt: Math.round(l.rtt_min_ms),
                        },
                    )}
                />
                {formatBitrate(l.bitrate_bytes_per_sec)}
            </span>,
            "num",
        ),
        cell(
            l.connected ? `${Math.round(l.rtt_ms)} ms` : "—",
            "num",
            t("dev.link_min_rtt", { rtt: Math.round(l.rtt_min_ms) }),
        ),
        cell(`${l.in_flight} / ${l.window}`, "num"),
        cell(l.nak_count, "num"),
        cell(`${((l.cc_loss_permille ?? 0) / 10).toFixed(1)}%`, "num"),
        cell(
            l.quality_multiplier !== undefined
                ? `×${l.quality_multiplier.toFixed(2)}`
                : "—",
            "num",
            l.base_score !== undefined
                ? t("dev.link_score", { score: l.base_score })
                : "",
        ),
    ];
}

function linkHeader(): m.Vnode {
    const th = (text: string, title?: string) => (
        <th class={"link-col"} title={title}>
            {text}
        </th>
    );
    return (
        <thead>
            <tr>
                <th>{t("dev.th.bond")}</th>
                <th>{t("dev.th.interface")}</th>
                <th>{t("dev.signal")}</th>
                <th>{t("dev.th.network")}</th>
                {th(t("dev.th.link"))}
                {th(t("mgmt.th_bitrate"))}
                {th("RTT")}
                {th(t("dev.th.in_flight"), t("dev.th.in_flight_title"))}
                {th(t("dev.th.naks"))}
                {th(t("dev.th.loss"))}
                {th(t("dev.th.quality"))}
            </tr>
        </thead>
    );
}

function interfacesCard(host: DeviceCard, status: Status): m.Vnode {
    const selected = new Set(status.selected.map((i) => i.iface));
    const live = host.st.stats;
    const stale =
        !!live &&
        !!host.st.statsAt &&
        Date.now() - host.st.statsAt > STATS_STALE_MS;
    const links = new Map((live?.links ?? []).map((l) => [l.ip, l]));
    const total =
        live?.links.reduce(
            (sum, l) => sum + (l.bitrate_bytes_per_sec || 0),
            0,
        ) ?? 0;

    const rows = status.interfaces.map((i) => {
        const sub = [
            i.cidr,
            i.modemIndex !== undefined
                ? t("dev.iface_modem", { index: i.modemIndex })
                : null,
        ]
            .filter(Boolean)
            .join(" · ");
        const network = [i.operatorName, i.accessTech]
            .filter(Boolean)
            .join(" · ");
        const busyKey = `iface:${i.iface}`;
        return (
            <tr key={i.iface} class={selected.has(i.iface) ? "selected" : ""}>
                <td>
                    <input
                        type={"checkbox"}
                        checked={selected.has(i.iface)}
                        disabled={host.busy.has(busyKey)}
                        title={t("dev.include_in_bond")}
                        onchange={() =>
                            void host.act(busyKey, "modems.toggle", {
                                iface: i.iface,
                            })
                        }
                    />
                </td>
                <td>
                    {i.iface}
                    {i.speed ? (
                        <small
                            class={
                                "muted"
                            }>{` · ${formatSpeed(i.speed)}`}</small>
                    ) : null}
                    {sub ? <span class={"iface-sub muted"}>{sub}</span> : null}
                </td>
                <td>{signal(i.signalQuality)}</td>
                <td>{network || "—"}</td>
                {linkCells(links.get(i.ip), total)}
            </tr>
        );
    });

    return (
        <Card
            title={t("dev.card.interfaces")}
            headActions={[
                stale && (
                    <Badge
                        text={t("dev.stale", {
                            time: since(host.st.statsAt),
                        })}
                        kind="warn"
                    />
                ),
                <Button
                    label={t("ui.reconfigure")}
                    disabled={host.busy.has("reconfigure")}
                    onclick={() => void host.act("reconfigure", "reconfigure")}
                />,
            ]}>
            <table class={live ? "" : "no-stats"}>
                {linkHeader()}
                {rows.length ? (
                    rows
                ) : (
                    <tr>
                        <td colspan={4 + LINK_COLUMNS} class={"muted"}>
                            {t("dev.no_interfaces")}
                        </td>
                    </tr>
                )}
            </table>
        </Card>
    );
}

// ----------------------------------------------------------------- modem panels

function modemAction(host: DeviceCard, method: string, index: number): void {
    if (
        method === "modems.reset" &&
        !confirm(t("dev.reset_confirm", { index }))
    )
        return;
    void host.act(`modem:${method}:${index}`, method, { index });
}

const stateKind = (state: string) =>
    state === "connected"
        ? "on"
        : state === "disabled" || state === "failed"
          ? "off"
          : "warn";

function modemPanel(host: DeviceCard, modem: ModemInfo): m.Vnode {
    const control = (label: string, method: string, cls = "secondary") => (
        <Button
            label={label}
            class={cls}
            disabled={
                host.busy.has(`modem:${method}:${modem.index}`) ||
                !!host.st.status?.state.srtla.running
            }
            onclick={() => modemAction(host, method, modem.index)}
        />
    );
    const connected = modem.state === "connected";
    const name =
        [modem.manufacturer, modem.model].filter(Boolean).join(" ") ||
        t("dev.modem_fallback");
    return (
        <article class={"modem"} key={modem.index}>
            <h3>
                <span>{`#${modem.index} ${name}`}</span>
                <Badge text={modem.state} kind={stateKind(modem.state)} />
            </h3>
            <DefinitionList
                rows={[
                    [t("dev.signal"), signal(modem.signalQuality)],
                    [t("dev.operator"), modem.operatorName],
                    [t("dev.tech"), modem.accessTech],
                    [t("dev.registration"), modem.registrationState],
                    [t("dev.power"), modem.powerState],
                    [t("dev.imei"), modem.imei],
                ]}
            />
            <Actions>
                {control(t("ui.enable"), "modems.enable")}
                {control(t("ui.disable"), "modems.disable")}
                {connected
                    ? control(t("ui.disconnect"), "modems.disconnect")
                    : control(t("ui.connect"), "modems.connect")}
                {control(t("ui.reset"), "modems.reset", "danger")}
            </Actions>
        </article>
    );
}

function modemsCard(host: DeviceCard, status: Status): m.Vnode {
    return (
        <Card title={t("dev.card.modems")} class={"mod-modems"}>
            {status.modems.length ? (
                <div class={"grid"}>
                    {status.modems.map((modem) => modemPanel(host, modem))}
                </div>
            ) : (
                <p class={"muted"}>{t("dev.no_modems")}</p>
            )}
        </Card>
    );
}

/** The relay device's full card set (device page and dashboard widgets): the
 * SRTLA state card, the interfaces table with the live link stats, and the
 * modem panels. */
export function srtlaComposite(host: DeviceCard, status: Status): m.Vnode {
    return (
        <>
            {srtlaCardBody(host, status)}
            {interfacesCard(host, status)}
            {modemsCard(host, status)}
        </>
    );
}

const srtlaModule: BridgedModule = {
    id: "srtla",
    kind: "device-card",
    title: "SRTLA",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
    component: (status: Status) => srtlaComposite(card, status),
    cardBody: (host, status) =>
        srtlaComposite(host as DeviceCard, status as Status),
};

export default srtlaModule;
