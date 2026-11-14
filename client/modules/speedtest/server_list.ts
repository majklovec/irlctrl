/*
 * LibreSpeed server list: download, normalize, cache.
 *
 * The raw JSON array from `servers.php` is what gets passed to the CLI via
 * `--local-json` (persisted verbatim, atomic rename). The UI gets a
 * normalized view. 1-hour TTL: expired caches are served while a single
 * background refresh runs; a fetch + parse failure falls back to the stale
 * cache, and with no cache at all the list is `available: false` (the UI
 * offers only "Auto").
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpeedtestServer, SpeedtestServers } from "./types";

export const SERVERS_URL = "https://librespeed.org/backend-servers/servers.php";
export const SERVERS_TTL_MS = 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 10_000;
/** How many ping probes run at once and how long the whole pass may take. */
export const PING_CONCURRENCY = 12;
export const PING_TIMEOUT_MS = 1500;
export const PING_PASS_BUDGET_MS = 6000;

/**
 * Normalize the raw list for the UI. Requires numeric `id`, string `name`
 * and string `server`; malformed entries are dropped, never fatal.
 */
export function normalizeServers(raw: unknown): SpeedtestServer[] {
    if (!Array.isArray(raw)) return [];
    const out: SpeedtestServer[] = [];
    for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (
            typeof e.id !== "number" ||
            !Number.isFinite(e.id) ||
            typeof e.name !== "string" ||
            typeof e.server !== "string"
        )
            continue;
        const base = (e.server as string).replace(/\/$/, "");
        const pingPath =
            typeof e.pingURL === "string" && e.pingURL ? e.pingURL : "empty.php";
        out.push({
            id: e.id,
            name: e.name,
            sponsor: typeof e.sponsorName === "string" ? e.sponsorName : "",
            url: e.server,
            ping: null,
            pingUrl: `${base}/${pingPath.replace(/^\//, "")}`,
        });
    }
    return out;
}

/**
 * Measured servers first (ascending ping), the unmeasured keep their list
 * order after them. Stable for equal pings.
 */
export function sortServersByPing(servers: SpeedtestServer[]): SpeedtestServer[] {
    return [...servers].sort(
        (a, b) =>
            (a.ping ?? Number.MAX_SAFE_INTEGER) - (b.ping ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * One ping pass: probe every server's ping endpoint (concurrency-capped, with
 * a per-probe and a total time budget); failures stay `null`. Never throws.
 */
export async function measurePings(
    servers: SpeedtestServer[],
    opts: {
        now?: () => number;
        fetch?: (url: string, init?: RequestInit) => Promise<unknown>;
    } = {},
): Promise<void> {
    const now = opts.now ?? (() => performance.now());
    const doFetch =
        opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    const deadline = now() + PING_PASS_BUDGET_MS;
    const pending = servers.filter((s) => s.ping === null && s.pingUrl);
    let i = 0;
    const worker = async () => {
        for (;;) {
            if (now() > deadline) return;
            const s = pending[i++];
            if (!s) return;
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(),
                PING_TIMEOUT_MS,
            );
            const t0 = now();
            try {
                await doFetch(s.pingUrl, {
                    signal: controller.signal,
                    cache: "no-store",
                });
                s.ping = Math.round(now() - t0);
            } catch {
                // Unreachable / slow — the server simply sorts last.
            } finally {
                clearTimeout(timer);
            }
        }
    };
    await Promise.all(
        Array.from(
            { length: Math.min(PING_CONCURRENCY, pending.length) },
            () => worker(),
        ),
    );
}

/** A ping pass: fills each server's `ping` in place (injectable for tests). */
export type PingPass = (servers: SpeedtestServer[]) => Promise<void>;

/** A fetch function with the timeout behavior we need (injectable for tests). */
export type ListFetcher = (url: string) => Promise<string>;

export const defaultFetcher: ListFetcher = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        if (!res.ok)
            throw new Error(`server list fetch failed: HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
};

export interface ServerListCacheOptions {
    /** Directory holding `servers.json` (created on demand). */
    dir: string;
    fetch?: ListFetcher;
    /** The ping pass (measures each server's RTT in place). */
    ping?: PingPass;
    now?: () => number;
    ttlMs?: number;
    log?: (message: string) => void;
}

export class ServerListCache {
    readonly path: string;
    private readonly fetch: ListFetcher;
    private readonly now: () => number;
    private readonly ttlMs: number;
    private readonly log: (message: string) => void;
    /** Single-flight: concurrent refreshes share one download. */
    private inflight: Promise<void> | null = null;
    /** Single-flight: concurrent callers share one ping pass. */
    private pings: Promise<void> | null = null;
    /** In-memory copy of the cache (normalized + raw text + mtime). */
    private cached: {
        text: string;
        servers: SpeedtestServer[];
        at: number;
    } | null = null;

    constructor(private readonly opts: ServerListCacheOptions) {
        this.path = join(opts.dir, "servers.json");
        this.fetch = opts.fetch ?? defaultFetcher;
        this.now = opts.now ?? (() => Date.now());
        this.ttlMs = opts.ttlMs ?? SERVERS_TTL_MS;
        this.log = opts.log ?? (() => {});
    }

    /** Load the cache from disk (idempotent, cheap when absent). */
    async load(): Promise<void> {
        if (this.cached) return;
        try {
            const st = await stat(this.path);
            const text = (await Bun.file(this.path).text()).trim();
            const parsed = JSON.parse(text) as unknown;
            if (!Array.isArray(parsed)) throw new Error("not a JSON array");
            this.cached = {
                text,
                servers: normalizeServers(parsed),
                at: st.mtimeMs,
            };
        } catch {
            // No cache (or unreadable) — a fetch will populate it.
            this.cached = null;
        }
    }

    /** Absolute cache path, and whether it exists right now. */
    cacheInfo(): { path: string; exists: boolean } {
        return {
            path: this.path,
            exists: this.cached !== null,
        };
    }

    /** The normalized servers (empty when there is no cache). */
    get servers(): SpeedtestServer[] {
        return this.cached?.servers ?? [];
    }

    get cachedAt(): number | null {
        return this.cached?.at ?? null;
    }

    /** True when `id` is in the current cache (the pre-spawn consistency check). */
    hasServer(id: number): boolean {
        return this.cached?.servers.some((s) => s.id === id) ?? false;
    }

    get refreshing(): boolean {
        return this.inflight !== null;
    }

    /** One bounded ping pass for the current cache (single-flight). */
    private ensurePings(): Promise<void> {
        const pass: PingPass = this.opts.ping ?? measurePings;
        if (!this.pings)
            this.pings = pass(this.cached?.servers ?? []).finally(
                () => (this.pings = null),
            );
        return this.pings;
    }

    /**
     * The list for the UI, sorted by measured ping (unmeasured last). Serves
     * the cache, starts a background refresh when stale (or `force`) and a
     * bounded ping pass when anything is unmeasured. A failed refresh keeps
     * the stale cache; with no cache and a failed fetch → `available: false`.
     */
    async get(force = false): Promise<SpeedtestServers> {
        await this.load();
        const stale = !this.cached || this.now() - this.cached.at >= this.ttlMs;
        if (stale || force) void this.refresh();
        if (this.cached?.servers.some((s) => s.ping === null))
            await this.ensurePings();
        return {
            available: this.cached !== null,
            servers: sortServersByPing(this.cached?.servers ?? []),
            cachedAt: this.cached?.at ?? null,
            refreshing: this.inflight !== null,
        };
    }

    /** Download + validate + atomically persist; never rethrows (stale stays). */
    async refresh(): Promise<void> {
        if (this.inflight) return this.inflight;
        this.inflight = (async () => {
            let text: string;
            try {
                text = await this.fetch(SERVERS_URL);
                const parsed = JSON.parse(text) as unknown;
                if (!Array.isArray(parsed)) throw new Error("not a JSON array");
            } catch (err) {
                this.log(
                    `Server list refresh failed: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                return; // keep the stale cache
            }
            let tmp: string | null = null;
            try {
                await mkdir(this.opts.dir, { recursive: true });
                // Raw array verbatim: the CLI's `--local-json` input.
                tmp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
                await writeFile(tmp, text, { flag: "wx" });
                await rename(tmp, this.path);
                this.cached = {
                    text,
                    servers: normalizeServers(JSON.parse(text) as unknown),
                    at: this.now(),
                };
            } catch (err) {
                if (tmp) await unlink(tmp).catch(() => {});
                this.log(
                    `Server list cache write failed: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            } finally {
                this.inflight = null;
            }
        })();
        return this.inflight;
    }
}
