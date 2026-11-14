/*
 * Speedtest module settings: CLI flag > env > default (shared/args).
 * The data dir holds the server-list cache and the auto-downloaded binary;
 * results are never stored here (in-memory only).
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { argEnv } from "../../../shared/args";

/** Where servers.json + the downloaded binary live. */
export const SPEEDTEST_DIR = argEnv(
    "--speedtest-dir",
    "SPEEDTEST_DIR",
    join(tmpdir(), "librespeed"),
);

/**
 * The librespeed-cli binary: a path, or a name resolved on PATH. Absent →
 * PATH lookup, then the auto-downloaded copy in SPEEDTEST_DIR.
 */
export const SPEEDTEST_CLI = argEnv(
    "--speedtest-cli",
    "LIBRESPEED_CLI_PATH",
    "",
);
