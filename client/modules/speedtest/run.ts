/*
 * Speedtest run manager: single-flight spawn of librespeed-cli, NDJSON
 * parsing, live broadcast, the in-memory last result, cancel + hard-timeout
 * hygiene, and stale-orphan cleanup (speedtest.md §5.3, §8).
 *
 * No persistence: `lastResult` lives in this file's scope and is cleared on
 * process restart.
 */
import { readdir, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ApiError } from "../../../shared/params";
import { buildSpeedtestArgv } from "./argv";
import type {
    SpeedtestLast,
    SpeedtestReport,
    SpeedtestRunEvent,
} from "./types";
import { NdjsonParser, type SpeedtestCliEvent } from "./parser";
import type { ServerListCache } from "./server_list";

/** Hard-kill the child if it has not exited (duration × 3 + 30 s, spec §5.3). */
export const hardTimeoutMs = (durationSec: number | null): number =>
    Math.max(15, durationSec ?? 15) * 3 * 1000 + 30_000;

interface ActiveRun {
    runId: string;
    proc: Bun.Subprocess;
    serverId: number | null;
    interfaceName: string | null;
    startedAt: string;
    report: SpeedtestReport | null;
    stderrTail: string;
    timer: ReturnType<typeof setTimeout> | null;
    cancelling: boolean;
    /** The stdout/stderr pumps (joined before the final `exit` envelope). */
    stdoutDone?: Promise<void>;
    stderrDone?: Promise<void>;
}

export interface SpeedtestRunManagerOptions {
    /** Resolve the binary path (download on demand). */
    resolveBin: () => Promise<string>;
    /** Server-list cache (for --local-json + the stale-id consistency check). */
    list: ServerListCache;
    emit: (event: string, data: unknown, opts?: { retain?: boolean }) => void;
    log: (message: string) => void;
    /** Kill function (injectable for tests). */
    kill?: (proc: Bun.Subprocess, signal: string) => void;
    /** Test hook: build the child (argv is fixed at call time). */
    spawn?: (bin: string, args: string[], env: Record<string, string>) => Bun.Subprocess;
    now?: () => string;
}

export class SpeedtestRunManager {
    private run: ActiveRun | null = null;
    /** In-memory only — no DB, no file, no history (speedtest.md §6.3). */
    lastResult: SpeedtestLast | null = null;

    constructor(private readonly opts: SpeedtestRunManagerOptions) {}

    get activeRunId(): string | null {
        return this.run && this.run.proc.exitCode === null
            ? this.run.runId
            : null;
    }

    /**
     * Start a run. Throws ApiError 409 for a concurrent run
     * (`already_running`) and for a server id missing from the current cache
     * (`server_not_in_list` — no spawn in that case).
     */
    async start(opts: {
        serverId: number | null;
        interface?: string | null;
        duration?: number | null;
    }): Promise<{ runId: string }> {
        if (this.activeRunId)
            throw new ApiError("already_running", 409);

        // Consistency check: a picked server must be in the current cache
        // (the CLI itself would fail with "Server not found" otherwise).
        if (opts.serverId !== null) {
            const info = this.opts.list.cacheInfo();
            if (info.exists && !this.opts.list.hasServer(opts.serverId))
                throw new ApiError("server_not_in_list", 409);
        }

        const bin = await this.opts.resolveBin();
        const argv = this.buildArgv(opts);
        const runId = randomUUID();
        const now = this.opts.now ?? (() => new Date().toISOString());

        const spawn = this.opts.spawn ?? defaultSpawn;
        let proc: Bun.Subprocess;
        try {
            proc = spawn(
                bin,
                argv,
                { IRLCTRL_SPEEDTEST: "1" },
            );
        } catch (err) {
            throw new ApiError(
                `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
                500,
            );
        }

        const run: ActiveRun = {
            runId,
            proc,
            serverId: opts.serverId,
            interfaceName: opts.interface ?? null,
            startedAt: now(),
            report: null,
            stderrTail: "",
            timer: null,
            cancelling: false,
        };
        this.run = run;

        // The pumps must run to completion before `finish` decides the
        // run's outcome (result is emitted before exit, spec §6.2).
        run.stdoutDone = this.pumpStdout(run);
        run.stderrDone = this.pumpStderr(run);

        run.timer = setTimeout(() => {
            this.opts.log(`Speedtest run ${runId} timed out; killing`);
            this.killRun(run, "timeout");
        }, hardTimeoutMs(opts.duration ?? null));

        // Lifecycle is detached: `start` returns the runId immediately and
        // the UI is driven by events (result goes out before exit, spec §6.2).
        void (async () => {
            const code = await run.proc.exited.catch(() => null);
            await Promise.allSettled([run.stdoutDone, run.stderrDone]);
            this.finish(run, code);
        })();
        return { runId };
    }

    /** The argv the run manager passes to the binary (after the binary). */
    buildArgv(opts: {
        serverId: number | null;
        interface?: string | null;
        duration?: number | null;
    }): string[] {
        const info = this.opts.list.cacheInfo();
        return buildSpeedtestArgv({
            serverId: opts.serverId,
            interface: opts.interface ?? null,
            cachePath: info.path,
            cacheExists: info.exists,
            duration: opts.duration ?? null,
        });
    }

    /** SIGTERM (escalating to SIGKILL); emits a synthetic error + exit. */
    cancel(runId: string): void {
        const run = this.run;
        if (!run || run.runId !== runId || run.proc.exitCode !== null)
            throw new ApiError("no such run", 404);
        run.cancelling = true;
        this.killRun(run, "cancelled");
    }

    /** Module shutdown: kill the child if one is running. */
    async stop(): Promise<void> {
        const run = this.run;
        if (run && run.proc.exitCode === null) {
            this.killRun(run, "shutdown");
            await run.proc.exited.catch(() => {});
        }
    }

    // ── plumbing ──────────────────────────────────────────────

    private killRun(run: ActiveRun, reason: string): void {
        if (run.proc.exitCode !== null) return;
        if (run.timer) clearTimeout(run.timer);
        run.timer = null;
        const kill = this.opts.kill ?? ((p, s) =>
            p.kill(s as Parameters<Bun.Subprocess["kill"]>[0]));
        kill(run.proc, "SIGTERM");
        setTimeout(() => {
            if (run.proc.exitCode === null) kill(run.proc, "SIGKILL");
        }, 3_000);
        this.emitEvent(run, "error", {
            message:
                reason === "cancelled"
                    ? "Run cancelled"
                    : reason === "shutdown"
                        ? "irlctrl is shutting down"
                        : "Run timed out",
            exitCode: null,
            stderrTail: run.stderrTail,
        });
    }

    private finish(run: ActiveRun, code: number | null): void {
        if (run.timer) clearTimeout(run.timer);
        run.timer = null;
        if (this.run !== run) return; // a newer run replaced it (shouldn't happen)
        const ok = code === 0;
        if (ok && run.report) {
            this.lastResult = {
                runId: run.runId,
                interface: run.interfaceName,
                serverId: run.serverId,
                serverName: run.report.server?.name ?? null,
                startedAt: run.startedAt,
                finishedAt: (this.opts.now ?? (() => new Date().toISOString()))(),
                result: run.report,
            };
            this.opts.log(
                `Speedtest finished: ↓${this.fmt(run.report.download)} ` +
                    `↑${this.fmt(run.report.upload)} Mbps`,
            );
        } else if (!run.cancelling && code !== 0) {
            this.emitEvent(run, "error", {
                message: this.diagnose(code, run.stderrTail),
                exitCode: code,
                stderrTail: run.stderrTail,
            });
            this.opts.log(
                `Speedtest failed (exit ${code ?? "?"}): ${trimTail(run.stderrTail)}`,
            );
        }
        // `exit` is the last envelope; `result` already went out on the line.
        this.emitEvent(run, "exit", { code });
    }

    private diagnose(code: number | null, stderrTail: string): string {
        if (code === 132 || /illegal instruction/i.test(stderrTail))
            return "The binary crashed with an illegal instruction — it likely " +
                "does not match this CPU architecture (re-download it for this arch).";
        if (/server not found/i.test(stderrTail))
            return "Selected server is no longer available";
        return `librespeed-cli exited with code ${code ?? "?"}`;
    }

    private fmt(v: number): string {
        return (v ?? 0).toFixed(2);
    }

    private emitEvent<T extends SpeedtestRunEvent["kind"]>(
        run: ActiveRun,
        kind: T,
        data: Extract<SpeedtestRunEvent, { kind: T }>["data"],
    ): void {
        this.opts.emit(
            "speedtest.run",
            { runId: run.runId, kind, data } as SpeedtestRunEvent,
            // Retained: a newly opened card replays the newest frame.
            { retain: true },
        );
    }

    private async pumpStdout(run: ActiveRun): Promise<void> {
        const parser = new NdjsonParser();
        let stream: ReadableStream<Uint8Array> | null = null;
        try {
            stream = run.proc.stdout as ReadableStream<Uint8Array>;
        } catch {
            return;
        }
        const decoder = new TextDecoder();
        try {
            for await (const chunk of stream) {
                for (const event of parser.push(decoder.decode(chunk, { stream: true })))
                    this.dispatchRunEvent(run, event);
            }
            for (const event of parser.flush())
                this.dispatchRunEvent(run, event);
        } catch {
            // stream closed early on kill — the tail is discarded (spec §8.12)
        }
        if (parser.garbage > 0)
            this.opts.log(
                `Speedtest: ${parser.garbage} non-JSON stdout line(s) skipped`,
            );
    }

    private async pumpStderr(run: ActiveRun): Promise<void> {
        let stream: ReadableStream<Uint8Array> | null = null;
        try {
            stream = run.proc.stderr as ReadableStream<Uint8Array>;
        } catch {
            return;
        }
        const decoder = new TextDecoder();
        try {
            for await (const chunk of stream) {
                run.stderrTail = (run.stderrTail + decoder.decode(chunk, { stream: true }))
                    .slice(-4_000);
            }
        } catch {
            // ignore
        }
    }

    private dispatchRunEvent(run: ActiveRun, event: SpeedtestCliEvent): void {
        if (event.event === "result") {
            run.report = event.reports[0] ?? null;
            this.emitEvent(run, "result", event);
        } else if (event.event === "progress") {
            this.emitEvent(run, "progress", event);
        } else {
            this.emitEvent(run, "phase", event);
        }
    }
}

function defaultSpawn(
    bin: string,
    args: string[],
    env: Record<string, string>,
): Bun.Subprocess {
    return Bun.spawn([bin, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
    });
}

const trimTail = (s: string) => s.trim().split("\n").slice(-3).join(" | ").slice(0, 400);

/**
 * Kill stale orphans: children of a previous irlctrl process tagged with
 * IRLCTRL_SPEEDTEST=1 in their env (Linux /proc scan, best-effort).
 */
export async function killStaleSpeedtestChildren(
    log: (message: string) => void,
): Promise<void> {
    try {
        const dirs = await readdir("/proc");
        const mine = String(process.pid);
        for (const entry of dirs) {
            if (!/^\d+$/.test(entry) || entry === mine) continue;
            try {
                const fh = await open(`/proc/${entry}/environ`, "r");
                const buf = new Uint8Array((await fh.stat()).size);
                await fh.read(buf);
                await fh.close();
                const env = new TextDecoder().decode(buf);
                if (env.includes("IRLCTRL_SPEEDTEST=1")) {
                    process.kill(Number(entry), "SIGKILL");
                    log(`Killed stale speedtest child pid ${entry}`);
                }
            } catch {
                // vanished between readdir and open — skip
            }
        }
    } catch {
        // /proc unavailable (non-Linux) — nothing to clean
    }
}
