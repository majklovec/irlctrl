/* CLI arguments of the encoder module (env fallbacks as before). */
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { argEnv } from "../../shared/args";

const TMP = tmpdir();

export const ENCODER_BIN = argEnv("--encoder", "ENCODER_BIN", "belacoder");
export const PIPELINES_DIR = argEnv(
    "--pipelines",
    "PIPELINES_DIR",
    "/usr/share/belacoder/pipelines",
);
export const BITRATE_FILE = argEnv(
    "--bitrate-file",
    "BITRATE_FILE",
    join(TMP, "belacoder_br"),
);
/** ceracoder takes an INI config (-c) instead of belacoder's bitrate file (-b). */
export const IS_CERA = basename(ENCODER_BIN).includes("ceracoder");
export const CERACODER_CONF = argEnv(
    "--ceracoder-conf",
    "CERACODER_CONF",
    join(TMP, "ceracoder.conf"),
);
