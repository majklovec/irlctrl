/* Encoder card: status rows, the stream form and (on ceracoder devices) bitrate control. */
import m from "mithril";
import type {
    CeraBalancer,
    DeviceSummary,
    EncoderState,
    Pipeline,
    Role,
    SetupInfo,
    Status,
    SrtlaState,
} from "../../public/types";
import { BITRATE_KBPS } from "../../public/types";
import {
    Actions,
    Badge,
    Break,
    Button,
    Card,
    type Child,
    Checkbox,
    CheckField,
    DefinitionList,
    Field,
    FieldGroup,
    Form,
    Input,
    numberAttrs,
    Options,
    Select,
} from "../../public/ts/components/ui";
import { icon } from "../../public/ts/components/icons";
import { t } from "../../public/ts/i18n";
import type { MithrilJSXComponent } from "../../public/ts/jsx";
import {
    formatBitrate,
    inRange,
    optionalNumber,
    since,
} from "../../public/ts/util";
import { card, type DeviceCard } from "../../public/ts/device/store";
import type {
    DeviceDashboardWidget,
    ModuleSetupStep,
} from "../../public/ts/module-contracts";
import type { BridgedModule } from "./types";
import "./styles.css";

interface EncoderFields {
    pipeline: string;
    minBitrate: string;
    maxBitrate: string;
    latency: string;
    delay: string;
    streamid: string;
    encHost: string;
    encPort: string;
    audioSource: string;
    audioCodec: string;
    bitrateOverlay: boolean;
}

interface EncoderCardState {
    fields: EncoderFields;
    cera: {
        balancer: CeraBalancer;
        adaptive: Record<string, string>;
        aimd: Record<string, string>;
    };
    touched: Set<string>;
    pipelines: Pipeline[];
    pipelineDir: string;
    pipelinesLoaded: boolean;
    role?: Role;
}

const encoderStates = new WeakMap<DeviceCard, EncoderCardState>();

function encoderState(host: DeviceCard): EncoderCardState {
    let state = encoderStates.get(host);
    if (!state) {
        state = {
            fields: {
                pipeline: "",
                minBitrate: "",
                maxBitrate: "",
                latency: "",
                delay: "",
                streamid: "",
                encHost: "",
                encPort: "",
                audioSource: "",
                audioCodec: "aac",
                bitrateOverlay: false,
            },
            cera: {
                balancer: "adaptive",
                adaptive: {
                    incrStep: "",
                    decrStep: "",
                    incrInterval: "",
                    decrInterval: "",
                },
                aimd: {
                    incrStep: "",
                    decrMult: "",
                    incrInterval: "",
                    decrInterval: "",
                },
            },
            touched: new Set(),
            pipelines: [],
            pipelineDir: "",
            pipelinesLoaded: false,
        };
        encoderStates.set(host, state);
    }
    return state;
}

const EncoderIssueBadge = {
    view: ({ attrs: { role, e, srtla } }) => {
        if (!e.running)
            return <Badge text={t("dev.badge.stopped")} kind="off" />;
        if (role === "combined" && !srtla?.running)
            return (
                <Badge text={t("dev.badge.srtla_send_down")} kind="warn" />
            );
        if (!e.pid && e.restarts)
            return <Badge text={t("dev.badge.restarting")} kind="warn" />;
        return null;
    },
} as MithrilJSXComponent<{
    role: Role | undefined;
    e: EncoderState;
    srtla: SrtlaState | undefined;
}>;

function hasEncoderIssue(
    role: Role | undefined,
    encoder: EncoderState,
    srtla: SrtlaState | undefined,
): boolean {
    return (
        !encoder.running ||
        (role === "combined" && !srtla?.running) ||
        (!encoder.pid && !!encoder.restarts)
    );
}

const setupFields = {
    pipeline: "",
    minBitrate: String(BITRATE_KBPS.min),
    maxBitrate: "5000",
    audioSource: "",
    audioCodec: "aac",
    delay: "0",
    encoderHost: "",
    encoderPort: "6000",
    latency: "2000",
    streamid: "",
    bitrateOverlay: false,
};
const setupPort = numberAttrs(1, 65535);
const setupBitrate = {
    ...numberAttrs(BITRATE_KBPS.min, BITRATE_KBPS.max, undefined, 100),
    required: true,
};
const setupBitrateValid = (value: string) =>
    inRange(value, BITRATE_KBPS.min, BITRATE_KBPS.max);

const encoderSetupStep: ModuleSetupStep = {
    id: "encoder",
    title: "setup.step.encoder",
    subtitle: "setup.step.encoder_sub",
    roles: ["encoder", "combined"],
    isValid(role: Status["role"]) {
        return (
            !!setupFields.pipeline &&
            !!setupFields.audioSource &&
            setupBitrateValid(setupFields.minBitrate) &&
            setupBitrateValid(setupFields.maxBitrate) &&
            Number(setupFields.minBitrate) <= Number(setupFields.maxBitrate) &&
            inRange(setupFields.latency, 100, 10000) &&
            (role !== "encoder" ||
                (!!setupFields.encoderHost &&
                    inRange(setupFields.encoderPort, 1, 65535)))
        );
    },
    render(role: Status["role"], info: SetupInfo) {
        const standalone = role === "encoder";
        return (
            <>
                <Field
                    label={t("dev.row.pipeline")}
                    control={
                        <Select
                            target={setupFields}
                            prop="pipeline"
                            required={true}>
                            <Options
                                pairs={info.pipelines.map((p) => [p.id, p.id])}
                            />
                        </Select>
                    }
                />
                <Field
                    label={t("dev.field.min_bitrate")}
                    control={
                        <Input
                            target={setupFields}
                            prop="minBitrate"
                            {...setupBitrate}
                        />
                    }
                />
                <Field
                    label={t("dev.field.max_bitrate")}
                    control={
                        <Input
                            target={setupFields}
                            prop="maxBitrate"
                            {...setupBitrate}
                        />
                    }
                />
                <Field
                    label={t("dev.field.audio_source")}
                    control={
                        <Select
                            target={setupFields}
                            prop="audioSource"
                            required={true}>
                            <Options
                                pairs={info.audioSources.map((a) => [
                                    a.id,
                                    a.name,
                                ])}
                            />
                        </Select>
                    }
                />
                <Field
                    label={t("dev.field.audio_codec")}
                    control={
                        <Select target={setupFields} prop="audioCodec">
                            <Options
                                pairs={[
                                    ["aac", "AAC"],
                                    ["opus", "Opus"],
                                ]}
                            />
                        </Select>
                    }
                />
                <Field
                    label={t("dev.field.audio_delay")}
                    control={
                        <Input
                            target={setupFields}
                            prop="delay"
                            {...numberAttrs(-2000, 2000)}
                        />
                    }
                />
                {standalone && [
                    <Field
                        label={t("dev.field.stream_host")}
                        control={
                            <Input
                                target={setupFields}
                                prop="encoderHost"
                                placeholder={"192.168.1.10"}
                                required={true}
                            />
                        }
                    />,
                    <Field
                        label={t("dev.field.stream_srt_port")}
                        control={
                            <Input
                                target={setupFields}
                                prop="encoderPort"
                                {...setupPort}
                                required={true}
                            />
                        }
                    />,
                ]}
                <Field
                    label={t("dev.field.srt_latency")}
                    control={
                        <Input
                            target={setupFields}
                            prop="latency"
                            {...numberAttrs(100, 10000, undefined, 100)}
                            required={true}
                        />
                    }
                />
                <Field
                    label={t("dev.field.stream_id")}
                    control={
                        <Input
                            target={setupFields}
                            prop="streamid"
                            placeholder={t("ui.optional")}
                        />
                    }
                />
                <CheckField
                    label={t("dev.field.bitrate_overlay")}
                    control={
                        <Checkbox target={setupFields} prop="bitrateOverlay" />
                    }
                />
            </>
        );
    },
    config() {
        return {
            ...setupFields,
            minBitrate: Number(setupFields.minBitrate),
            maxBitrate: Number(setupFields.maxBitrate),
            delay: Number(setupFields.delay),
            encoderPort: Number(setupFields.encoderPort),
            latency: Number(setupFields.latency),
        };
    },
};

const encoderDashboardWidgets: DeviceDashboardWidget[] = [
            {
                type: "encoder",
                available: (device) =>
                    device.role === "encoder" ||
                    device.role === "custom" ||
                    device.role === undefined,
                defaultSize: { w: 6, h: 5 },
                minSize: { w: 4, h: 4 },
                body: ({ card: host, status }) =>
                    status ? encoderCardBody(host, status) : null,
                badge: ({ device, status }) => {
                    const encoder = device.encoder ?? status?.state.encoder;
                    if (!encoder)
                        return (
                            <Badge
                                text={
                                    status
                                        ? t("dash.widget_waiting")
                                        : t("dev.badge.offline")
                                }
                                kind={status ? "" : "off"}
                            />
                        );
                    return (
                        <Badge
                            text={
                                encoder.running
                                    ? t("dev.badge.online")
                                    : t("dev.badge.stopped")
                            }
                            kind={encoder.running ? "on" : "warn"}
                        />
                    );
                },
            },
            {
                type: "combined",
                available: (device) =>
                    device.role === "combined" ||
                    device.role === "custom" ||
                    device.role === undefined,
                defaultSize: { w: 6, h: 10 },
                minSize: { w: 4, h: 8 },
                body: ({ card: host, status }) =>
                    status ? encoderCardBody(host, status) : null,
            },
        ];

const encoderSummaryColumns = [
            {
                id: "stream",
                order: 0,
                available: (device: DeviceSummary) =>
                    device.role === "encoder" || device.role === "combined",
                header: () => t("mgmt.th.stream"),
                cell: (device: DeviceSummary) => {
                    if (!device.online) return "—";
                    const encoder = device.encoder;
                    if (!encoder) return "—";
                    if (hasEncoderIssue(device.role, encoder, device.srtla))
                        return (
                            <EncoderIssueBadge
                                role={device.role}
                                e={encoder}
                                srtla={device.srtla}
                            />
                        );
                    if (device.activeLinks === 0)
                        return <Badge text={t("dev.badge.no_links")} kind="warn" />;
                    return <Badge text={t("dev.badge.live")} kind="on" />;
                },
            },
            {
                id: "bitrate",
                order: 10,
                available: () => true,
                header: () => t("mgmt.th_bitrate"),
                cell: (device: DeviceSummary) => {
                    const live =
                        device.online && device.bitrate !== undefined
                            ? formatBitrate(device.bitrate)
                            : null;
                    const max =
                        device.maxBitrate !== undefined
                            ? t("dev.max_value", {
                                  value: formatBitrate(device.maxBitrate * 125),
                              })
                            : null;
                    if (live && max)
                        return (
                            <span>
                                {live}
                                {" / "}
                                <span class={"muted"}>{max}</span>
                            </span>
                        );
                    return live ?? max ?? "—";
                },
            },
            {
                id: "encoder",
                order: 30,
                available: (device: DeviceSummary) =>
                    device.role === "encoder" || device.role === "combined",
                header: () => [icon("encoder"), ` ${t("setup.step.encoder")}`],
                cell: (device: DeviceSummary) => {
                    const encoder = device.encoder;
                    if (!encoder) return "—";
                    return encoder.running ? (
                        <Badge
                            text={encoder.config?.pipeline ?? t("dev.badge.streaming")}
                            kind="on"
                        />
                    ) : (
                        <Badge text={t("dev.badge.stopped")} kind="warn" />
                    );
                },
            },
];

function prefillString(
    current: string,
    value: unknown,
    field: string,
): string {
    if (current || value == null || value === "") return current;
    if ((document.activeElement as HTMLInputElement | null)?.name === field)
        return current;
    return String(value);
}

function syncEncoderForm(host: DeviceCard, status: Status): void {
    const state = encoderState(host);
    const { fields, touched, cera } = state;
    const config = status.state.encoder.config;
    const combined = status.role === "combined";

    if (state.role !== status.role) touched.clear();
    state.role = status.role;

    if (!combined) {
        fields.encHost = prefillString(fields.encHost, config?.host, "encHost");
        fields.encPort = prefillString(fields.encPort, config?.port, "encPort");
    }
    fields.minBitrate = prefillString(
        fields.minBitrate,
        config?.minBitrate ?? status.ceracoder?.minBitrate,
        "minBitrate",
    );
    fields.maxBitrate = prefillString(
        fields.maxBitrate,
        config?.maxBitrate,
        "maxBitrate",
    );
    fields.latency = prefillString(fields.latency, config?.latency, "latency");
    fields.delay = prefillString(fields.delay, config?.delay, "delay");
    fields.streamid = prefillString(fields.streamid, config?.streamid, "streamid");

    if (!fields.pipeline && !touched.has("pipeline") && config?.pipeline)
        fields.pipeline = config.pipeline;
    if (!state.pipelines.some((pipeline) => pipeline.id === fields.pipeline))
        fields.pipeline = "";

    const savedAudioSource = config?.audioSource;
    const savedSourcePresent =
        !!savedAudioSource &&
        status.audioSources.some((source) => source.id === savedAudioSource);
    if (
        fields.audioSource &&
        !status.audioSources.some((source) => source.id === fields.audioSource)
    ) {
        fields.audioSource = savedSourcePresent
            ? savedAudioSource
            : status.audioSources[0]?.id ?? "";
    } else if (
        !fields.audioSource &&
        !touched.has("audioSource") &&
        savedSourcePresent
    ) {
        fields.audioSource = savedAudioSource;
    }
    if (!touched.has("audioCodec") && config?.audioCodec)
        fields.audioCodec = config.audioCodec;
    if (!touched.has("bitrateOverlay") && config)
        fields.bitrateOverlay = !!config.bitrateOverlay;

    const ceraConfig = status.ceracoder;
    if (ceraConfig) {
        if (!touched.has("balancer")) cera.balancer = ceraConfig.balancer;
        for (const group of ["adaptive", "aimd"] as const)
            for (const [key, value] of Object.entries(ceraConfig[group]))
                cera[group][key] = prefillString(
                    cera[group][key] ?? "",
                    value,
                    `${group}.${key}`,
                );
    }
}

async function loadPipelines(host: DeviceCard): Promise<void> {
    const state = encoderState(host);
    if (state.pipelinesLoaded) return;
    state.pipelinesLoaded = true;
    const result = await host.act<
        { dir: string; pipelines: Pipeline[] } | undefined
    >(null, "pipelines.list");
    if (!result || !Array.isArray(result.pipelines)) {
        state.pipelinesLoaded = false;
        return;
    }
    state.pipelineDir = result.dir;
    state.pipelines = result.pipelines;
    if (state.pipelines.length === 0) state.pipelinesLoaded = false;
    const current =
        state.fields.pipeline ||
        host.st.status?.state.encoder.config?.pipeline ||
        "";
    state.fields.pipeline = state.pipelines.some(
        (pipeline) => pipeline.id === current,
    )
        ? current
        : "";
    m.redraw();
}

const hasEncoderRole = (status: Status) =>
    status.role !== "relay" && status.role !== "obs";

// ----------------------------------------------------------------------
// Stream control (owns the encoder + stream start logic, shared with SRTLA)
// ----------------------------------------------------------------------

/** The pipeline currently selected in the form (or the default one). */
export function selectedPipeline(host: DeviceCard): Pipeline | undefined {
    const state = encoderState(host);
    return state.pipelines.find((pipeline) => pipeline.id === state.fields.pipeline);
}

/** Submit the encoder / stream form: the chosen pipeline, bitrate, audio and target. */
function encoderStart(
    host: DeviceCard,
    combinedTarget?: { remoteHost: string; remotePort: string },
): void {
    const status = host.st.status;
    const { fields } = encoderState(host);
    if (!status) return;
    const pipeline = selectedPipeline(host);
    const common = {
        pipeline: fields.pipeline,
        minBitrate: optionalNumber(fields.minBitrate),
        maxBitrate: optionalNumber(fields.maxBitrate),
        latency: optionalNumber(fields.latency),
        delay: optionalNumber(fields.delay),
        streamid: fields.streamid || undefined,
        // Options the selected pipeline does not support are hidden; do not send their stale values
        audioSource: pipeline?.asrc
            ? fields.audioSource || undefined
            : "default",
        audioCodec: pipeline?.acodec
            ? fields.audioCodec || undefined
            : undefined,
        bitrateOverlay: pipeline?.overlay ? fields.bitrateOverlay : false,
    };
    if (status.role === "combined") {
        if (!combinedTarget?.remoteHost || !combinedTarget.remotePort) return;
        host.press("encoder-start", "stream.start", {
            ...common,
            remoteHost: combinedTarget.remoteHost,
            remotePort: combinedTarget.remotePort,
        });
    } else {
        if (!fields.encHost || !fields.encPort) return;
        host.press("encoder-start", "encoder.start", {
            ...common,
            host: fields.encHost,
            port: fields.encPort,
        });
    }
}

/** Start / Stop buttons for a stream (encoder card, or the SRTLA card of a combined device). */
function streamButtons(
    host: DeviceCard,
    stopMethod: string,
): m.Children {
    const status = host.st.status;
    const canStart = !!status && !status.state.encoder.running;
    const canStop =
        !!status &&
        (status.state.encoder.running ||
            (status.role === "combined" && status.state.srtla.running));
    return (
        <Actions>
            <Button
                label={t("ui.start")}
                type={"submit"}
                disabled={!canStart || host.pending("encoder-start")}
            />
            <Button
                label={t("ui.stop")}
                class={"danger"}
                disabled={!canStop || host.pending("encoder-stop")}
                onclick={() => host.press("encoder-stop", stopMethod)}
            />
        </Actions>
    );
}

// ----------------------------------------------------------------------
// ceracoder bitrate control
// ----------------------------------------------------------------------
type Param = readonly [key: string, labelKey: string, attrs: m.Attributes];
const BITRATE_ATTRS = (placeholder: string) =>
    numberAttrs(BITRATE_KBPS.min, BITRATE_KBPS.max, placeholder, 100);
const STEP = (placeholder: string) => numberAttrs(1, 10000, placeholder);
const INTERVAL = (placeholder: string) => numberAttrs(10, 60000, placeholder);
const CERA_PARAMS: Record<Exclude<CeraBalancer, "fixed">, readonly Param[]> = {
    adaptive: [
        ["incrStep", "dev.field.cera_incr_step", STEP("30")],
        ["decrStep", "dev.field.cera_decr_step", STEP("100")],
        ["incrInterval", "dev.field.cera_incr_interval", INTERVAL("500")],
        ["decrInterval", "dev.field.cera_decr_interval", INTERVAL("200")],
    ],
    aimd: [
        ["incrStep", "dev.field.cera_incr_step", STEP("50")],
        [
            "incrMult",
            "dev.field.cera_incr_mult",
            numberAttrs(0, 1, "0.75", 0.01),
        ],
        ["incrInterval", "dev.field.cera_incr_interval", INTERVAL("500")],
        ["decrInterval", "dev.field.cera_decr_interval", INTERVAL("200")],
    ],
};

const numbers = (group: Record<string, string>) =>
    Object.fromEntries(
        Object.entries(group).map(([k, v]) => [k, optionalNumber(v)]),
    );

function ceracoderControls(host: DeviceCard): m.Children {
    const { cera, touched } = encoderState(host);
    const group = cera.balancer === "fixed" ? null : cera.balancer;
    return (
        <FieldGroup legend={t("dev.cera_section")}>
            <Field
                label={t("dev.field.balancer")}
                control={
                    <Select
                        target={cera}
                        prop="balancer"
                        onChange={() => touched.add("balancer")}>
                        <Options
                            pairs={(["adaptive", "fixed", "aimd"] as const).map(
                                (b) => [b, t(`dev.balancer.${b}`)],
                            )}
                        />
                    </Select>
                }
            />
            <Break />
            {group &&
                CERA_PARAMS[group].map(([key, labelKey, attrs]) => (
                    <Field
                        key={`${group}.${key}`}
                        label={t(labelKey)}
                        control={
                            <Input
                                target={cera[group] as Record<string, string>}
                                prop={key}
                                {...attrs}
                                name={`${group}.${key}`}
                            />
                        }
                    />
                ))}
            <Actions>
                <Button
                    label={t("dev.apply_cera")}
                    class={"secondary"}
                    disabled={
                        !host.st.status?.ceracoder ||
                        host.pending("ceracoder-apply")
                    }
                    onclick={() =>
                        host.press("ceracoder-apply", "ceracoder.set", {
                            balancer: cera.balancer,
                            adaptive: numbers(cera.adaptive),
                            aimd: numbers(cera.aimd),
                        })
                    }
                />
            </Actions>
        </FieldGroup>
    );
}

// ----------------------------------------------------------------------
// Card
// ----------------------------------------------------------------------
const stateBadge = ({ role, state: { encoder, srtla } }: Status): m.Vnode =>
    hasEncoderIssue(role, encoder, srtla) ? (
        <EncoderIssueBadge role={role} e={encoder} srtla={srtla} />
    ) : (
        <Badge text={t("dev.badge.streaming")} kind={"on"} />
    );

function pipelineOptions(host: DeviceCard): m.Children {
    const { pipelines, pipelineDir } = encoderState(host);
    const groups = new Map<string, Pipeline[]>();
    for (const p of pipelines)
        groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
    if (!groups.size)
        return (
            <option
                value={""}
                disabled={
                    true
                }>{`${t("dev.no_pipelines", { directory: pipelineDir })} ${t("dev.no_pipelines_hint")}`}</option>
        );
    return [...groups].map(([group, list]) => {
        const opts = (
            <Options
                key={group || "ungrouped"}
                pairs={list.map((p) => [p.id, p.name])}
            />
        );
        return group ? (
            <optgroup key={group} label={group}>
                {opts}
            </optgroup>
        ) : (
            opts
        );
    });
}

function statusRows(host: DeviceCard, status: Status): [string, Child][] {
    const { fields } = encoderState(host);
    const { encoder: e } = status.state;
    const cfg = e.config;
    const combined = status.role === "combined";
    const audioName = status.audioSources.find(
        (a) => a.id === fields.audioSource,
    )?.name;
    return [
        [t("dev.row.state"), stateBadge(status)],
        [t("dev.row.encoder"), status.ceracoder ? "ceracoder" : "belacoder"],
        [t("dev.row.pipeline"), cfg?.pipeline],
        // Combined devices stream into their own srtla_send, so the target row is hidden for them
        ...(combined
            ? []
            : [
                  [
                      t("dev.row.target"),
                      e.running && cfg ? `${cfg.host}:${cfg.port}` : null,
                  ] as [string, Child],
              ]),
        [
            t("dev.row.bitrate"),
            cfg &&
                t("dev.minmax_kbps", {
                    min:
                        cfg.minBitrate ??
                        status.ceracoder?.minBitrate ??
                        BITRATE_KBPS.min,
                    max: cfg.maxBitrate,
                }),
        ],
        [
            t("dev.row.latency"),
            cfg &&
                t("dev.latency_audio", {
                    latency: cfg.latency,
                    audioDelay: cfg.delay,
                }),
        ],
        [
            t("dev.row.audio"),
            cfg &&
                `${audioName ?? cfg.audioSource ?? t("dev.audio_pipeline_default")}, ${(cfg.audioCodec ?? "aac").toUpperCase()}`,
        ],
        [t("dev.row.started"), e.running ? since(e.startedAt) : null],
        [t("dev.row.restarts"), e.running ? e.restarts ?? 0 : null],
    ];
}

export function encoderCardBody(host: DeviceCard, status: Status): m.Vnode {
    const { fields, touched } = encoderState(host);
    const combined = status.role === "combined";
    const pipeline = selectedPipeline(host);
    return (
        <Card title={t("dev.card.encoder")} class={"mod-encoder"}>
            <DefinitionList rows={statusRows(host, status)} />
            <Form onSubmit={() => encoderStart(host)}>
                <FieldGroup legend={t("dev.group.video")}>
                    <Field
                        label={t("dev.row.pipeline")}
                        control={
                            <Select
                                target={fields}
                                prop="pipeline"
                                required={true}
                                onChange={() => touched.add("pipeline")}>
                                {pipelineOptions(host)}
                            </Select>
                        }
                    />
                    {pipeline?.overlay && (
                        <CheckField
                            label={t("dev.field.bitrate_overlay")}
                            control={
                                <Checkbox
                                    target={fields}
                                    prop="bitrateOverlay"
                                    onChange={() =>
                                        touched.add("bitrateOverlay")
                                    }
                                />
                            }
                        />
                    )}
                </FieldGroup>
                <FieldGroup legend={t("dev.group.bitrate")}>
                    <Field
                        label={t("dev.field.min_bitrate")}
                        control={
                            <Input
                                target={fields}
                                prop="minBitrate"
                                {...BITRATE_ATTRS(String(BITRATE_KBPS.min))}
                            />
                        }
                    />
                    <Field
                        label={t("dev.field.max_bitrate")}
                        control={
                            <span class={"actions"}>
                                <Input
                                    target={fields}
                                    prop="maxBitrate"
                                    {...BITRATE_ATTRS("5000")}
                                />
                                <Button
                                    label={t("dev.apply_bitrate")}
                                    class={"secondary"}
                                    disabled={
                                        !status.state.encoder.running ||
                                        host.pending("encoder-bitrate")
                                    }
                                    onclick={() =>
                                        host.press(
                                            "encoder-bitrate",
                                            "encoder.bitrate",
                                            {
                                                minBitrate: optionalNumber(
                                                    fields.minBitrate,
                                                ),
                                                maxBitrate: optionalNumber(
                                                    fields.maxBitrate,
                                                ),
                                            },
                                        )
                                    }
                                />
                            </span>
                        }
                    />
                </FieldGroup>
                {status.ceracoder && ceracoderControls(host)}
                <FieldGroup legend={t("dev.group.audio")}>
                    {pipeline?.asrc && (
                        <Field
                            label={t("dev.field.audio_source")}
                            control={
                                <Select
                                    target={fields}
                                    prop="audioSource"
                                    onChange={() => touched.add("audioSource")}>
                                    <Options
                                        pairs={status.audioSources.map((a) => [
                                            a.id,
                                            a.name,
                                        ])}
                                    />
                                </Select>
                            }
                        />
                    )}
                    {pipeline?.acodec && (
                        <Field
                            label={t("dev.field.audio_codec")}
                            control={
                                <Select
                                    target={fields}
                                    prop="audioCodec"
                                    onChange={() => touched.add("audioCodec")}>
                                    <Options
                                        pairs={[
                                            ["aac", "AAC"],
                                            ["opus", "Opus"],
                                        ]}
                                    />
                                </Select>
                            }
                        />
                    )}
                    <Field
                        label={t("dev.field.audio_delay")}
                        control={
                            <Input
                                target={fields}
                                prop="delay"
                                {...numberAttrs(-2000, 2000, "0")}
                            />
                        }
                    />
                </FieldGroup>
                <FieldGroup legend={t("dev.group.srt")}>
                    {!combined && (
                        <>
                            <Field
                                label={t("dev.field.stream_host")}
                                control={
                                    <Input
                                        target={fields}
                                        prop="encHost"
                                        placeholder={"192.168.1.10"}
                                        required={true}
                                    />
                                }
                            />
                            <Field
                                label={t("dev.field.stream_srt_port")}
                                control={
                                    <Input
                                        target={fields}
                                        prop="encPort"
                                        placeholder={"6000"}
                                        required={true}
                                    />
                                }
                            />
                            <Break />
                        </>
                    )}
                    <Field
                        label={t("dev.field.srt_latency")}
                        control={
                            <Input
                                target={fields}
                                prop="latency"
                                {...numberAttrs(100, 10000, "2000", 100)}
                            />
                        }
                    />
                    <Field
                        label={t("dev.field.stream_id")}
                        control={
                            <Input
                                target={fields}
                                prop="streamid"
                                placeholder={t("ui.optional")}
                            />
                        }
                    />
                </FieldGroup>
                {!combined && [<Break />, streamButtons(host, "encoder.stop")]}
            </Form>
        </Card>
    );
}

const encoderModule: BridgedModule = {
    id: "encoder",
    kind: "device-card",
    title: "Encoder",
    order: 10,
    available: (status) => status.role !== "relay" && status.role !== "obs",
    dashboardWidgets: encoderDashboardWidgets,
    setupSteps: [encoderSetupStep],
    deviceSummaryColumns: encoderSummaryColumns,
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
    component: (status: Status) => encoderCardBody(card, status),
    handleEvent(event, _data, host) {
        if (!host) return;
        host.provideCapability("encoder.start", encoderStart);
        host.provideCapability("encoder.streamButtons", streamButtons);
        const state = encoderState(host);
        const status = host.st.status;
        if (event === "open") state.pipelinesLoaded = false;
        if (event === "status" && status) {
            status.state.encoder ??= { running: false };
            syncEncoderForm(host, status);
        }
        if (status && hasEncoderRole(status)) void loadPipelines(host);
    },
};

export default encoderModule;
