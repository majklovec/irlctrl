/* CLI arguments of the encoder module (env fallbacks as before). */
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { arg } from "../../shared/args";

const TMP = tmpdir();

export const ENCODER_BIN = arg(
    "--encoder",
    process.env.ENCODER_BIN ?? "belacoder",
);
export const PIPELINES_DIR = arg(
    "--pipelines",
    process.env.PIPELINES_DIR ?? "/usr/share/belacoder/pipelines",
);
export const BITRATE_FILE = arg("--bitrate-file", join(TMP, "belacoder_br"));
/** ceracoder takes an INI config (-c) instead of belacoder's bitrate file (-b). */
export const IS_CERA = basename(ENCODER_BIN).includes("ceracoder");
export const CERACODER_CONF = arg(
    "--ceracoder-conf",
    join(TMP, "ceracoder.conf"),
);
