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
        out.push({
            id: e.id,
            name: e.name,
            sponsor: typeof e.sponsorName === "string" ? e.sponsorName : "",
            url: e.server,
        });
    }
    return out;
}

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

    /**
     * The list for the UI: serve the cache, start a background refresh when
     * it is stale (or when `force`). A failed refresh keeps the stale cache;
     * with no cache and a failed fetch → `available: false`.
     */
    async get(force = false): Promise<SpeedtestServers> {
        await this.load();
        const stale = !this.cached || this.now() - this.cached.at >= this.ttlMs;
        if (stale || force) void this.refresh();
        return {
            available: this.cached !== null,
            servers: this.cached?.servers ?? [],
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
