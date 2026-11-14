/*
 * librespeed-cli binary resolution (speedtest.md §5.2, acceptance: the
 * binary is not committed — it resolves LIBRESPEED_CLI_PATH → PATH →
 * auto-download). The downloaded copy lives in the module data dir.
 */
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { linuxArchAsset } from "./arch";

export const CLI_NAME = "librespeed-cli";
const RELEASE_API =
    "https://api.github.com/repos/librespeed/speedtest-cli/releases/latest";

/** Find `name` on PATH; null when absent. */
export function which(name: string): string | null {
    try {
        const res = Bun.spawnSync(["which", name]);
        if (res.exitCode === 0) {
            const path = res.stdout.toString().trim();
            if (path) return path;
        }
    } catch {
        // which is unavailable — the download path below still works
    }
    return null;
}

/** A `uname -m` probe (injectable for tests). */
export type Uname = () => Promise<string>;

export const defaultUname: Uname = async () => {
    try {
        const res = Bun.spawnSync(["uname", "-m"]);
        const out = res.stdout.toString().trim();
        if (out) return out;
    } catch {
        // fall through
    }
    throw new Error("unable to detect the machine architecture (uname -m)");
};

/** The release asset (linux tar.gz) matching the detected arch. */
export function pickAsset(
    assets: { name: string; browser_download_url: string }[],
    uname: string,
): { name: string; url: string } {
    const arch = linuxArchAsset(uname); // throws on unsupported arches
    const re = new RegExp(`^librespeed-cli_.*_linux_${arch}\\.tar\\.gz$`);
    const hit = assets.find((a) => re.test(a.name));
    if (!hit)
        throw new Error(
            `no ${arch} release asset in the librespeed-cli listing ` +
                `(detected arch: ${uname})`,
        );
    return { name: hit.name, url: hit.browser_download_url };
}

/**
 * Probe a binary for the `--json-stream` flag. The module's protocol
 * (spec §5.1) depends on it, and the newest GitHub release (v1.0.14)
 * predates the flag — it exists in master builds only. Without the probe
 * a stale binary would die on spawn with an unparsable
 * `flag provided but not defined` error, so we check up front.
 */
export async function probeJsonStreamSupport(bin: string): Promise<boolean> {
    try {
        // Some builds print help to stderr; read both.
        const proc = Bun.spawn([bin, "--help"], {
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
        });
        const [out, err] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        return (out + "\n" + err).includes("--json-stream");
    } catch {
        return false;
    }
}

export interface CliResolverOptions {
    /** Data dir for the auto-downloaded binary (created on demand). */
    dir: string;
    /** LIBRESPEED_CLI_PATH / `--speedtest-cli` value (path or PATH name). */
    explicit?: string;
    fetch?: (url: string) => Promise<Uint8Array>;
    uname?: Uname;
    log?: (message: string) => void;
}

export class CliResolver {
    readonly localPath: string;
    private readonly explicit: string | undefined;
    private readonly fetch: (url: string) => Promise<Uint8Array>;
    private readonly uname: Uname;
    private readonly log: (message: string) => void;
    private downloadInflight: Promise<string> | null = null;

    constructor(private readonly opts: CliResolverOptions) {
        this.localPath = join(opts.dir, CLI_NAME);
        this.explicit = opts.explicit;
        this.fetch =
            opts.fetch ??
            (async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()));
        this.uname = opts.uname ?? defaultUname;
        this.log = opts.log ?? (() => {});
    }

    /**
     * Resolve the binary to an executable path:
     * explicit path → module data dir → cwd (a checked-out build next to
     * the app) → PATH → auto-download.
     * The winning binary must support `--json-stream`; otherwise a clear
     * diagnostic is thrown (the newest release, v1.0.14, lacks the flag).
     */
    async resolve(): Promise<string> {
        const candidates: string[] = [];
        if (this.explicit) {
            if (this.explicit.includes("/")) candidates.push(this.explicit);
            else {
                const onPath = which(this.explicit);
                if (onPath) candidates.push(onPath);
                else candidates.push(this.explicit); // last-ditch: may resolve via cwd
            }
        }
        candidates.push(this.localPath);
        const cwdBin = join(process.cwd(), CLI_NAME);
        if (!candidates.includes(cwdBin)) candidates.push(cwdBin);
        const onPath = which(CLI_NAME);
        if (onPath) candidates.push(onPath);
        for (const bin of candidates)
            if (await isExecutable(bin)) {
                await this.requireJsonStream(bin);
                return bin;
            }
        const bin = await this.download();
        await this.requireJsonStream(bin);
        return bin;
    }

    private async requireJsonStream(bin: string): Promise<void> {
        if (await probeJsonStreamSupport(bin)) return;
        throw new Error(
            `librespeed-cli at ${bin} does not support --json-stream. ` +
                "The newest GitHub release (v1.0.14) predates the flag — " +
                "point LIBRESPEED_CLI_PATH at a master build of " +
                "librespeed/speedtest-cli, or delete the local copy to retry " +
                "the download.",
        );
    }

    /** Download the matching linux release asset and extract it locally. */
    async download(): Promise<string> {
        if (this.downloadInflight) return this.downloadInflight;
        this.downloadInflight = (async () => {
            try {
                const res = await this.fetch(RELEASE_API);
                let meta: { assets: { name: string; browser_download_url: string }[] };
                try {
                    meta = JSON.parse(new TextDecoder().decode(res));
                } catch {
                    throw new Error("malformed release metadata");
                }
                const uname = await this.uname();
                const asset = pickAsset(meta.assets, uname);
                this.log(
                    `Downloading ${asset.name} (arch ${uname}) …`,
                );
                const tarball = await this.fetch(asset.url);
                await mkdir(this.opts.dir, { recursive: true });
                const tarPath = join(this.opts.dir, `${CLI_NAME}.tar.gz`);
                await writeFile(tarPath, tarball);
                const extractDir = join(this.opts.dir, ".extract");
                await rm(extractDir, { recursive: true, force: true });
                await mkdir(extractDir, { recursive: true });
                const tar = Bun.spawn(
                    ["tar", "-xzf", tarPath, "-C", extractDir],
                );
                const code = await tar.exited;
                if (code !== 0)
                    throw new Error(`tar extraction failed (exit ${code})`);
                const glob = new Bun.Glob("**/*");
                const paths = [...glob.scanSync({ cwd: extractDir, absolute: true })];
                const files = (
                    await Promise.all(
                        paths.map(async (p) => {
                            try {
                                return (await stat(p)).isFile() ? p : null;
                            } catch {
                                return null;
                            }
                        }),
                    )
                ).filter((p): p is string => p !== null);
                if (files.length === 0)
                    throw new Error("release archive is empty");
                await rename(files[0], this.localPath);
                await chmod(this.localPath, 0o755);
                await rm(extractDir, { recursive: true, force: true });
                await rm(tarPath, { force: true });
                this.log(`librespeed-cli installed to ${this.localPath}`);
                return this.localPath;
            } finally {
                this.downloadInflight = null;
            }
        })();
        return this.downloadInflight;
    }
}

async function isExecutable(path: string): Promise<boolean> {
    try {
        const st = await stat(path);
        return st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
        return false;
    }
}
