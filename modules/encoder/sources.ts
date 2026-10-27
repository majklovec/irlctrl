/*
 * What the encoder can run: the GStreamer pipeline files under PIPELINES_DIR
 * (including subdirectories — generic/, rk3588/, jetson/, custom/, ...; a
 * pipeline's id is its path relative to that directory) and the ALSA capture
 * cards it can record from.
 *
 * Before launch the pipeline is adapted like belaUI does: the ALSA capture
 * card can be swapped or audio dropped, AAC can be replaced by Opus, and the
 * bitrate text overlay is removed unless requested. The result goes to a
 * temp file.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { errorMessage } from "../../shared/util";
import { PIPELINES_DIR } from "./config";
import { core } from "./core";
import type { AudioSource, EncoderConfig, Pipeline } from "./types";

const PIPELINE_TMP = join(tmpdir(), "srtla_belacoder_pipeline");
const pipelinesRoot = (): string => resolve(PIPELINES_DIR);

// Same patterns belaUI uses to recognise the tweakable parts of a pipeline
const ALSA_SRC = /alsasrc device=[A-Za-z0-9:=]+/;
const ALSA_BRANCH = /alsasrc device=[A-Za-z0-9:]+(.|[\s])*?mux\. *\s?/;
const AAC_ENCODER = /voaacenc\s+bitrate=(\d+)\s+!\s+aacparse\s+!/;
const BITRATE_OVERLAY = /textoverlay[^!]*name=overlay[^!]*!/g;

export const AUDIO_DEFAULT = "default"; // keep the card named in the pipeline
export const AUDIO_NONE = "none"; // strip the audio branch
export const AUDIO_CODECS = ["aac", "opus"] as const;

/** Pipeline files under `dir`, skipping dot entries and directories that cannot be read. */
async function pipelineFiles(dir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
        console.warn(`Cannot read pipelines from ${dir}: ${errorMessage(err)}`);
        return [];
    }
    const visible = entries.filter((e) => !e.name.startsWith("."));
    const nested = await Promise.all(
        visible
            .filter((e) => e.isDirectory())
            .map((e) => pipelineFiles(join(dir, e.name))),
    );
    return [
        ...visible.filter((e) => e.isFile()).map((e) => join(dir, e.name)),
        ...nested.flat(),
    ];
}

export async function listPipelines(): Promise<Pipeline[]> {
    const root = pipelinesRoot();
    const files = await pipelineFiles(root);
    const list = await Promise.all(
        files.map(async (file): Promise<Pipeline> => {
            const id = relative(root, file).split(sep).join("/");
            const slash = id.indexOf("/");
            const text = await readFile(file, "utf8").catch(() => "");
            return {
                id,
                group: slash < 0 ? "" : id.slice(0, slash),
                name: id.slice(slash + 1),
                asrc: ALSA_BRANCH.test(text),
                acodec: AAC_ENCODER.test(text),
                overlay: new RegExp(BITRATE_OVERLAY.source).test(text),
            };
        }),
    );
    return list.sort(
        (a, b) =>
            a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
    );
}

/** Map a pipeline id to its file, refusing anything outside PIPELINES_DIR. */
export async function resolvePipeline(id: string): Promise<string> {
    const root = pipelinesRoot();
    const file = resolve(root, id);
    if (!file.startsWith(root + sep))
        throw new Error(`Invalid pipeline: ${id}`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`Unknown pipeline: ${id}`);
    return file;
}

// ----------------------------------------------------------------------
// Audio sources (ALSA cards), mirroring belaUI's filtering and ordering
// ----------------------------------------------------------------------
const AUDIO_EXCLUDE = new Set([
    "tegrahda",
    "tegrasndt210ref",
    "rockchipdp0",
    "rockchiphdmi0",
    "rockchiphdmi1",
    "rockchiphdmi2",
    "rockchiphdmiind",
    "rockchipes8316",
]);
const AUDIO_PRIORITY = [
    "HDMI",
    "rockchiphdmiin",
    "rockchipes8388",
    "C4K",
    "usbaudio",
];
const AUDIO_ALIASES: Record<string, string> = {
    C4K: "Cam Link 4K",
    usbaudio: "USB audio",
    rockchiphdmiin: "HDMI",
    rockchipes8388: "Analog in",
};
const CARD_ID = /^[A-Za-z0-9_-]+$/;

export async function listAudioSources(): Promise<AudioSource[]> {
    const dir = "/sys/class/sound";
    const cards = (await readdir(dir).catch(() => [] as string[])).filter((n) =>
        /^card\d+$/.test(n),
    );
    const cardIds = await Promise.all(
        cards.map((n) => readFile(`${dir}/${n}/id`, "utf8").catch(() => "")),
    );
    const ids = new Set(
        cardIds
            .map((id) => id.trim())
            .filter((id) => id && CARD_ID.test(id) && !AUDIO_EXCLUDE.has(id)),
    );
    const ordered = [
        ...AUDIO_PRIORITY.filter((id) => ids.has(id)),
        ...[...ids].filter((id) => !AUDIO_PRIORITY.includes(id)).sort(),
    ];
    return [
        ...ordered.map((id) => ({ id, name: AUDIO_ALIASES[id] ?? id })),
        { id: AUDIO_DEFAULT, name: "Pipeline default" },
        { id: AUDIO_NONE, name: "No audio" },
    ];
}

/** Write the pipeline with audio / overlay adjustments applied; returns the file to run. */
export async function preparePipeline(
    file: string,
    cfg: EncoderConfig,
    write = true,
): Promise<string> {
    let text = await readFile(file, "utf8");
    if (!text.trim())
        throw new Error(
            `Pipeline is empty: ${relative(pipelinesRoot(), file)}`,
        );
    const source = cfg.audioSource ?? AUDIO_DEFAULT;

    if (source === AUDIO_NONE) {
        text = text.replace(ALSA_BRANCH, "");
    } else if (source !== AUDIO_DEFAULT && ALSA_SRC.test(text)) {
        if (!CARD_ID.test(source))
            throw new Error(`Invalid audio source: ${source}`);
        const available = (await listAudioSources()).some(
            (a) => a.id === source,
        );
        if (!available) throw new Error(`Audio source not found: ${source}`);
        text = text.replace(ALSA_SRC, `alsasrc device="hw:${source}"`);
    }

    if (cfg.audioCodec === "opus") {
        text = text.replace(
            AAC_ENCODER,
            (_m, br: string) =>
                `audioresample quality=10 sinc-filter-mode=1 ! opusenc bitrate=${br} ! opusparse !`,
        );
    }

    if (!cfg.bitrateOverlay) text = text.replace(BITRATE_OVERLAY, "");

    if (write && !core.config.DRY_RUN)
        await core.writeFileAtomic(PIPELINE_TMP, text);
    return PIPELINE_TMP;
}
