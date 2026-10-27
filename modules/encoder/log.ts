/** Log wording of the encoder module's methods (registered by both the backend and the frontend). */
import {
    type LogWording,
    logTranslate,
    wording,
} from "../../shared/logMessages";

const repoImported = (p: Record<string, unknown>) =>
    logTranslate("mlog.done.repo_imported", { repository: p.repository });

const log: LogWording = {
    methods: {
        "encoder.start": wording("Encoder", "Start", "mlog.done.started"),
        "encoder.stop": wording("Encoder", "Stop", "mlog.done.stopped"),
        "encoder.bitrate": wording("Encoder", "Bitrate change", (p) =>
            logTranslate("mlog.done.bitrate", {
                minBitrate: p.minBitrate,
                maxBitrate: p.maxBitrate,
            }),
        ),
        "ceracoder.set": wording(
            "Encoder",
            "Bitrate control",
            "mlog.done.cera_settings",
        ),
        "stream.start": wording("Stream", "Start", "mlog.done.started"),
        "stream.stop": wording("Stream", "Stop", "mlog.done.stopped"),
        "pipelines.create": wording("Pipelines", "Create", (p) =>
            logTranslate("mlog.done.pipeline_created", { id: p.id }),
        ),
        "pipelines.update": wording("Pipelines", "Update", (p) =>
            logTranslate("mlog.done.pipeline_updated", { id: p.id }),
        ),
        "pipelines.delete": wording("Pipelines", "Delete", (p) =>
            logTranslate("mlog.done.pipeline_deleted", { id: p.id }),
        ),
        "pipelines.repositories.add": wording(
            "Pipelines",
            "Import repository",
            repoImported,
        ),
        "pipelines.repositories.update": wording(
            "Pipelines",
            "Import repository",
            repoImported,
        ),
        "pipelines.repositories.remove": wording(
            "Pipelines",
            "Delete repository",
            (p) =>
                logTranslate("mlog.done.repo_removed", {
                    repository: p.repository,
                }),
        ),
        "pipelines.repositories.updateAll": wording(
            "Pipelines",
            "Import all repositories",
            "mlog.done.repos_imported",
        ),
    },
    reads: {
        "pipelines.list": wording("Pipelines", "Load", "mlog.done.loaded"),
    },
    sections: { encoder: "Encoder", stream: "Stream", pipelines: "Pipelines" },
    labels: {
        Encoder: "mlog.section.encoder",
        Pipelines: "mlog.section.pipelines",
        Stream: "mgmt.th.stream",
        "Bitrate change": "mlog.action.bitrate",
    },
};

export default log;
