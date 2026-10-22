/*
 * Dedicated pipeline editor: /pipelines/new/ and /pipelines/edit/<id>/.
 * Replaces the inline pipeline editor that used to live in the encoder
 * settings card — the list there now links here.
 *
 * The page sits one folder deeper than /settings/ in both the control
 * server (/d/<id>/pipelines/…) and the device-local API (/pipelines/…), so
 * the WebSocket URL and the back link are derived from the device base
 * (everything before /pipelines/). Saving returns to the settings page.
 */
import m from "mithril";
import {
    Button,
    ConnectionBadge,
    Field,
    Form,
    Input,
    Page,
    TitleWithBack,
} from "../../frontend/ts/components/ui";
import { t } from "../../frontend/ts/i18n";
import { RpcClient, socketUrl } from "../../frontend/ts/services/rpc";
import { mountPage, setHeaderColor } from "../../frontend/ts/util";
import { errorMessage } from "../../shared/util";
import "./pipeline-editor.css";

/** HTML `pattern` for a pipeline id (backend/client/pipelines.ts PIPELINE_ID_RE). */
const PIPELINE_PATH_PATTERN = "[A-Za-z0-9_.\\-]+(\\/[A-Za-z0-9_.\\-]+)*";

type Mode = "new" | "edit";

/** The device base: everything before /pipelines/ plus a trailing slash.
 * /d/<id>/pipelines/… → /d/<id>/  ;  /pipelines/… → / */
const base = (() => {
    const i = location.pathname.indexOf("/pipelines/");
    return (i >= 0 ? location.pathname.slice(0, i) : "") + "/";
})();

/** /pipelines/new/ → new ; /pipelines/edit/<id>/ → edit. The id lives in a
 * single path segment, %‑encoded (slashes as %2F), so decodeURIComponent
 * yields the full group/name pipeline id (decodeURI would leave %2F in). */
const parsed: { mode: Mode; id: string } = (() => {
    const i = location.pathname.indexOf("/pipelines/");
    const tail = location.pathname.slice(i + "/pipelines/".length);
    let decoded = tail;
    try {
        decoded = decodeURIComponent(tail);
    } catch {
        // raw % in a hand-typed URL: keep the segment as-is
    }
    if (decoded.startsWith("edit/"))
        // strip the route's trailing slash: /pipelines/edit/<id>/
        return {
            mode: "edit",
            id: decoded.slice("edit/".length).replace(/\/+$/, ""),
        };
    return { mode: "new", id: "" };
})();

/* ── GStreamer syntax highlighting ─────────────────────────────────
 * Element names are coloured by category, caps filters and `!` get the
 * caps colour. `name=value` properties, `pad::prop=value` ghost-pad
 * props and `.pad` / `.prop=value` element chains are coloured: the
 * key (everything up to and including `=`, or the whole `.pad` when
 * no `=` is present) gets the link colour, the value gets the value
 * colour. The palette is the blockly.html reference adapted to the
 * dark theme.
 * ─────────────────────────────────────────────────────────────────── */

const CATEGORIES: Record<
    string,
    { label: string; color: string; tip: string }
> = {
    source: {
        label: "source",
        color: "#3fb950",
        tip: "Produces data (e.g. *src, videotestsrc)",
    },
    sink: {
        label: "sink",
        color: "#f85149",
        tip: "Consumes data (e.g. *sink, appsink)",
    },
    parser: {
        label: "parser",
        color: "#a371f7",
        tip: "Parses a bitstream (e.g. h264parse)",
    },
    demuxer: {
        label: "demuxer",
        color: "#bc8cff",
        tip: "Splits streams or dynamically builds sub-pipelines (e.g. flvdemux, decodebin)",
    },
    muxer: {
        label: "muxer",
        color: "#58a6ff",
        tip: "Multiplexes streams (e.g. mpegtsmux)",
    },
    decoder: {
        label: "decoder",
        color: "#f0883e",
        tip: "Decodes (e.g. avdec_h264, nvv4l2decoder)",
    },
    encoder: {
        label: "encoder",
        color: "#db61a2",
        tip: "Encodes (e.g. x264enc, voaacenc)",
    },
    converter: {
        label: "converter",
        color: "#79c0ff",
        tip: "Format / scale / rate conversion",
    },
    filter: {
        label: "filter",
        color: "#9f2121",
        tip: "Processing element (identity, queue, volume…)",
    },
    other: {
        label: "other",
        color: "#6e7681",
        tip: "Uncategorised element",
    },
};

const CATEGORY_ORDER = [
    "source",
    "sink",
    "parser",
    "demuxer",
    "muxer",
    "decoder",
    "encoder",
    "converter",
    "filter",
    "other",
];

const PIPE_COLORS = {
    caps: "#d29922",
    link: "#39c5cf",
    value: "#c9d1d9",
};

const RULES = {
    decoder: [/^avdec_/, /decoder$|dec$/],
    encoder: [/^avenc_/, /enc$/],
    // `decodebin`, `parsebin`, `dynbin`… split / build streams like demuxers.
    demuxer: [/demux$/, /(rtp|rtcp).*depay$/, /bin$/],
    muxer: [/mux$/, /(rtp|rtcp).*pay$/],
    parser: [/parse$/],
    source: [/src$/],
    sink: [/sink$/],
    converter: [
        /convert$/,
        /conv$/,
        /resample$/,
        /scale$/,
        /deinterlace$/,
        /videorate$/,
        /audiorate$/,
        /postproc$/, // e.g. vapostproc
    ],
    filter: [
        /compositor$/, // e.g. nvcompositor, glvideocompositor
        /mix$/, // e.g. audiochannelmix
        /overlay$/,
        /^(identity|queue|volume|tee|valve|capssetter|textoverlay|videobox|imagefreeze|clockoverlay)$/,
    ],
} as const satisfies Record<string, readonly RegExp[]>;

type ElementType = keyof typeof RULES | "other";

function classifyElement(name: string): ElementType {
    const n = String(name).toLowerCase();
    for (const type in RULES) {
        for (const pattern of RULES[type as keyof typeof RULES]) {
            if (pattern.test(n)) return type as ElementType;
        }
    }
    return "other";
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A double- or single-quoted string (with backslash escapes). */
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
/** A property value: quoted, or a bare run up to whitespace / `!`. */
const VALUE = String.raw`(?:${QUOTED}|[^\s!]+)`;

/** One token of a GStreamer launch string. Alternatives, in order:
 *  - caps filter: `video/x-raw[(features)][,field=value…]`
 *  - `!` link
 *  - property:    `name=value`, `pad::prop=value`
 *  - pad chain:   `.pad`, `.prop=value`, or bare `.`
 *  - element:     bare identifier
 *  - anything else (whitespace, punctuation, `=`, numbers…)
 *
 *  Caps and props are tried before the element alternative so their `/`
 *  and `=` never get shredded into fake element names. */
const TOKEN_RE = new RegExp(
    [
        String.raw`(?<caps>[a-z][a-z0-9_.-]*\/[a-z0-9_.-]+(?:\([^)]*\))?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_.-]*=[^\s!,;]+)*)`,
        String.raw`!`,
        String.raw`(?<prop>[A-Za-z_][A-Za-z0-9_-]*(?:::[A-Za-z_][A-Za-z0-9_-]*)?=${VALUE})`,
        String.raw`(?<dot>\.(?:[A-Za-z_][A-Za-z0-9_-]*)?(?:=${VALUE})?)`,
        String.raw`(?<elem>[A-Za-z_][A-Za-z0-9_-]*)`,
        String.raw`[^A-Za-z_!.]+`,
    ].join("|"),
    "y",
);

/** Render an `=` assignment (`key=value`, `pad::prop=value`,
 * `.prop=value`, or bare `.pad`) with the key in the link colour and the
 * value in the value colour. Splitting on the first `=` is unambiguous:
 * keys cannot contain `=`, and any `=` in the value is preserved. */
function htmlAssignment(s: string): string {
    const eq = s.indexOf("=");
    if (eq < 0) return `<span class="hl-link">${escapeHtml(s)}</span>`;
    return (
        `<span class="hl-link">${escapeHtml(s.slice(0, eq + 1))}</span>` +
        `<span class="hl-value">${escapeHtml(s.slice(eq + 1))}</span>`
    );
}

/** Tokenize a GStreamer launch string into highlighted HTML. */
function highlightPipeline(text: string): string {
    let html = "";
    let i = 0;
    while (i < text.length) {
        TOKEN_RE.lastIndex = i;
        const m = TOKEN_RE.exec(text);
        if (!m) break;
        const g = m.groups ?? {};
        if (g.caps !== undefined) {
            html += `<span class="hl-caps">${escapeHtml(g.caps)}</span>`;
        } else if (g.prop !== undefined) {
            html += htmlAssignment(g.prop);
        } else if (g.dot !== undefined) {
            html += htmlAssignment(g.dot);
        } else if (g.elem !== undefined) {
            html += `<span class="hl-${classifyElement(g.elem)}">${escapeHtml(
                g.elem,
            )}</span>`;
        } else if (m[0] === "!") {
            html += `<span class="hl-caps">!</span>`;
        } else {
            html += escapeHtml(m[0]);
        }
        i = TOKEN_RE.lastIndex;
    }
    // Trailing newline: <pre> doesn't render the caret line of a textarea
    // that ends in \n without it.
    return html + "<br>";
}

const state = {
    mode: parsed.mode as Mode,
    /** "edit": the fixed pipeline id; "new": the path the user is choosing. */
    id: parsed.id,
    content: "",
    /** highlighted HTML of content, kept in sync by onContentInput */
    highlighted: "<br>",
    loading: parsed.mode === "edit",
    loaded: false,
    notFound: false,
    connected: false,
    saving: false,
    message: "",
};

const rpc = new RpcClient(() => socketUrl(base + "ws"));

/** Repaint the highlighted underlay from state.highlighted (in place). */
function paintHighlight(): void {
    const pre = document.querySelector<HTMLPreElement>(".pipe-code");
    if (pre) pre.innerHTML = state.highlighted;
}

/** Textarea input: refresh the highlighted underlay in place (avoids a full
 * m.redraw for every keystroke). */
function onContentInput(this: HTMLTextAreaElement): void {
    state.content = this.value;
    state.highlighted = highlightPipeline(this.value);
    paintHighlight();
}

/** Keep the highlighted underlay scrolled in sync with the textarea. */
function onTextScroll(this: HTMLTextAreaElement): void {
    const pre = this.previousElementSibling;
    if (pre && "scrollTop" in pre) {
        const p = pre as HTMLPreElement;
        p.scrollTop = this.scrollTop;
        p.scrollLeft = this.scrollLeft;
    }
}

/** Load the existing pipeline's content (edit mode only). */
async function load(): Promise<void> {
    try {
        const res = await rpc.call<{ id: string; content: string }>(
            "pipelines.get",
            { id: state.id },
        );
        state.id = res.id;
        state.content = res.content;
        state.highlighted = highlightPipeline(res.content);
        paintHighlight();
        state.loaded = true;
    } catch {
        state.notFound = true;
    } finally {
        state.loading = false;
        m.redraw();
    }
}

/** Colour swatch legend for the highlighted editor: titled box with the
 * swatches arranged in even grid rows. */
function editorLegend() {
    return (
        <div class={"pipe-legend-box"}>
            <div class={"pipe-legend-title"}>{t("set.pipeline_legend")}</div>
            <div class={"pipe-legend"}>
                {CATEGORY_ORDER.map((cat) => (
                    <span
                        key={cat}
                        class={"pipe-legend-item"}
                        style={`--swatch: ${CATEGORIES[cat].color}`}
                        title={CATEGORIES[cat].tip}>
                        <span class={"pipe-legend-swatch"} />
                        {CATEGORIES[cat].label}
                    </span>
                ))}
                <span
                    class={"pipe-legend-item"}
                    style={`--swatch: ${PIPE_COLORS.caps}`}
                    title="Caps negotiation or link (e.g. video/x-raw, !)">
                    <span class={"pipe-legend-swatch"} />
                    caps
                </span>
                <span
                    class={"pipe-legend-item"}
                    style={`--swatch: ${PIPE_COLORS.link}`}
                    title="Property key or pad reference (name=, elem.pad, pad::prop=)">
                    <span class={"pipe-legend-swatch"} />
                    key / pad
                </span>
                <span
                    class={"pipe-legend-item"}
                    style={`--swatch: ${PIPE_COLORS.value}`}
                    title="Property value (name=value, elem.prop=value)">
                    <span class={"pipe-legend-swatch"} />
                    value
                </span>
            </div>
        </div>
    );
}

/** Tint the page with the device's configured header colour (same as the
 * device store does on its pages). */
function loadAppearance(): void {
    void rpc
        .call<{ settings: { color: string } }>("settings.get")
        .then((result) => {
            if (result) setHeaderColor(result.settings.color);
        })
        .catch(() => undefined);
}

rpc.on("open", () => {
    state.connected = true;
    loadAppearance();
    m.redraw();
    // Load once; a (re)connect must not clobber unsaved edits.
    if (state.mode === "edit" && !state.loaded && !state.notFound) void load();
});
rpc.on("close", () => {
    state.connected = false;
    m.redraw();
});

async function save(): Promise<void> {
    const id = state.id.trim();
    if (!id || state.saving) return;
    state.saving = true;
    state.message = "";
    m.redraw();
    try {
        await rpc.call(
            state.mode === "new" ? "pipelines.create" : "pipelines.update",
            { id, content: state.content },
        );
        location.href = base + "settings/";
    } catch (error: unknown) {
        state.message = errorMessage(error);
        state.saving = false;
        m.redraw();
    }
}

function goBack(): void {
    location.href = base + "settings/";
}

const pageTitle = () =>
    state.mode === "new"
        ? t("set.pipeline_new")
        : t("set.pipeline_editing", { id: state.id });

const App: m.Component = {
    view() {
        if (state.notFound)
            return (
                <Page
                    title={pageTitle()}
                    headerRight={
                        <ConnectionBadge connected={state.connected} />
                    }>
                    <p class={"muted"} role={"alert"}>
                        {t("set.pipeline_not_found", { id: state.id })}
                    </p>
                </Page>
            );
        if (state.loading)
            return (
                <Page
                    title={pageTitle()}
                    headerRight={
                        <ConnectionBadge connected={state.connected} />
                    }>
                    <p class={"muted"}>{t("mgmt.loading")}</p>
                </Page>
            );

        return (
            <Page
                title={
                    <TitleWithBack
                        href={base + "settings/"}
                        backLabel={t("ui.back")}>
                        {pageTitle()}
                    </TitleWithBack>
                }
                headerRight={<ConnectionBadge connected={state.connected} />}>
                <Form class={"pipeline-editor"} onSubmit={() => void save()}>
                    {state.mode === "new" ? (
                        <Field
                            label={t("set.pipeline_path")}
                            control={
                                <Input
                                    target={state}
                                    prop="id"
                                    required={true}
                                    pattern={PIPELINE_PATH_PATTERN}
                                    placeholder={t("set.pipeline_path_ph")}
                                />
                            }
                        />
                    ) : (
                        <div class={"pipeline-editor-head"}>
                            <span class={"pipeline-editor-head-label"}>
                                {t("set.pipeline_path")}
                            </span>
                            <code class={"pipeline-editor-id"}>{state.id}</code>
                        </div>
                    )}
                    <Field
                        label={t("set.pipeline_content")}
                        control={
                            <div class={"pipe-code-wrap"}>
                                <pre class={"pipe-code"}>
                                    {m.trust(state.highlighted)}
                                </pre>
                                <textarea
                                    class={"pipeline-editor-text"}
                                    rows={14}
                                    wrap="off"
                                    spellCheck={false}
                                    value={state.content}
                                    oninput={onContentInput}
                                    onscroll={onTextScroll}
                                    onkey={(e: Event) => {
                                        const key = e as KeyboardEvent;
                                        if (
                                            (key.ctrlKey || key.metaKey) &&
                                            key.key === "s"
                                        ) {
                                            key.preventDefault();
                                            void save();
                                        }
                                    }}
                                />
                            </div>
                        }
                    />
                    {editorLegend()}
                    <div class={"pipeline-editor-actions"}>
                        <Button
                            label={
                                state.mode === "new"
                                    ? t("set.pipeline_add")
                                    : t("ui.save")
                            }
                            type={"submit"}
                            title={t("set.pipeline_save_hint")}
                            disabled={state.saving}
                        />
                        <Button
                            label={t("ui.cancel")}
                            class={"secondary"}
                            disabled={state.saving}
                            onclick={goBack}
                        />
                    </div>
                    <p class={"muted"} role={"status"}>
                        {state.message}
                    </p>
                </Form>
            </Page>
        );
    },
};

void mountPage(() => t("set.pipelines"), App);
