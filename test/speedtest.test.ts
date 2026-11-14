/*
 * Speedtest module tests: the argv truth table (spec §5.1), the NDJSON
 * parser, the server-list cache (TTL, atomic fallback), interface
 * enumeration, the ARM asset mapping, and the run manager (single-flight,
 * stale server id, cancel, in-memory last result — no persistence).
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildSpeedtestArgv,
    type SpeedtestArgvOptions,
} from "../client/modules/speedtest/argv";
import type { SpeedtestServer } from "../client/modules/speedtest/types";
import { linuxArchAsset } from "../client/modules/speedtest/arch";
import { instantMbps } from "../client/modules/speedtest/inst_mbps";
import { pickAsset } from "../client/modules/speedtest/cli";
import { listInterfaces, pickDefaultInterface } from "../client/modules/speedtest/interfaces";
import { NdjsonParser, parseLine } from "../client/modules/speedtest/parser";
import {
    measurePings,
    normalizeServers,
    ServerListCache,
    sortServersByPing,
} from "../client/modules/speedtest/server_list";
import {
    CliResolver,
    probeJsonStreamSupport,
} from "../client/modules/speedtest/cli";
import {
    hardTimeoutMs,
    SpeedtestRunManager,
} from "../client/modules/speedtest/run";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const readFixture = (name: string) =>
    Bun.file(new URL(name, FIXTURES)).text();

// ── argv truth table (spec §5.1) ─────────────────────────────

describe("argv construction (spec §5.1 truth table)", () => {
    const base = { cachePath: "./data/servers.json" };
    type CaseOpts = Omit<SpeedtestArgvOptions, "cachePath">;
    const cases: [string, CaseOpts, string[]][] = [
        [
            "server + iface + cache",
            { ...base, serverId: 105, interface: "wwx001e101f0000", cacheExists: true },
            ["--json-stream", "--local-json", "./data/servers.json", "--server", "105", "--interface", "wwx001e101f0000"],
        ],
        [
            "server, no iface, cache",
            { ...base, serverId: 105, interface: null, cacheExists: true },
            ["--json-stream", "--local-json", "./data/servers.json", "--server", "105"],
        ],
        [
            "no server, iface, cache",
            { ...base, serverId: null, interface: "wwx001e101f0000", cacheExists: true },
            ["--json-stream", "--local-json", "./data/servers.json", "--interface", "wwx001e101f0000"],
        ],
        [
            "nothing, cache",
            { ...base, serverId: null, interface: null, cacheExists: true },
            ["--json-stream", "--local-json", "./data/servers.json"],
        ],
        [
            "server + iface, NO cache",
            { ...base, serverId: 105, interface: "wwx001e101f0000", cacheExists: false },
            ["--json-stream", "--server", "105", "--interface", "wwx001e101f0000"],
        ],
        [
            "server, no iface, NO cache",
            { ...base, serverId: 105, interface: null, cacheExists: false },
            ["--json-stream", "--server", "105"],
        ],
        [
            "no server, iface, NO cache",
            { ...base, serverId: null, interface: "en0", cacheExists: false },
            ["--json-stream", "--interface", "en0"],
        ],
    ];
    for (const [name, opts, want] of cases)
        test(name, () => {
            // cases carry base (cachePath) at runtime; the type drops it.
            expect(buildSpeedtestArgv(opts as SpeedtestArgvOptions)).toEqual(want);
        });
    test("Auto omits --server entirely", () => {
        expect(
            buildSpeedtestArgv({ ...base, serverId: null, interface: null, cacheExists: true }),
        ).not.toContain("--server");
    });
    test("duration override appends --duration", () => {
        expect(
            buildSpeedtestArgv({ ...base, serverId: null, interface: null, cacheExists: true, duration: 30 }),
        ).toEqual(["--json-stream", "--local-json", "./data/servers.json", "--duration", "30"]);
    });
});

// ── NDJSON parser ────────────────────────────────────────────

describe("NDJSON parser", () => {
    test("fixture → 3 phase + 30 progress + 1 result, 0 garbage", async () => {
        const text = await readFixture("speedtest-sample.ndjson");
        const parser = new NdjsonParser();
        const events = [...parser.push(text), ...parser.flush()];
        const by = (event: string) =>
            events.filter((e) => e.event === event).length;
        expect(by("phase")).toBe(3);
        expect(by("progress")).toBe(30);
        expect(by("result")).toBe(1);
        expect(parser.garbage).toBe(0);
        const result = events.find((e) => e.event === "result");
        expect(result).not.toBeUndefined();
    });

    test("partial trailing line is dropped at flush", () => {
        const parser = new NdjsonParser();
        const events = parser.push('{"event":"phase","phase":"ping"}\n{"event":"prog');
        expect(events).toHaveLength(1);
        expect(parser.flush()).toHaveLength(0);
        expect(parser.garbage).toBe(1);
    });

    test("non-JSON banner lines are skipped", () => {
        const parser = new NdjsonParser();
        const events = parser.push(
            "LibreSpeed CLI v1.0\n{\"event\":\"phase\",\"phase\":\"download\"}\n",
        );
        expect(events).toHaveLength(1);
        expect(parser.garbage).toBe(1);
    });

    test("garbage is split across chunks without losing events", () => {
        const parser = new NdjsonParser();
        const chunk1 = parser.push('{"event":"phase","pha');
        const chunk2 = parser.push('se":"ping"}\n');
        expect([...chunk1, ...chunk2]).toEqual([{ event: "phase", phase: "ping" }]);
    });

    test("parseLine rejects malformed events", () => {
        expect(parseLine('{"event":"progress","phase":"download"}')).toBeNull();
        expect(parseLine('{"event":"result"}')).toBeNull();
        expect(parseLine("[1,2,3]")).toBeNull();
        expect(parseLine("not json")).toBeNull();
    });
});

// ── server list: normalize + cache TTL ──────────────────────

describe("server list", () => {
    test("normalizeServers drops malformed entries", async () => {
        const raw = (await readFixture("servers-sample.json")) as string;
        const servers = normalizeServers(JSON.parse(raw));
        expect(servers).toEqual([
            {
                id: 105,
                name: "Frankfurt, Germany (FS IT-Systeme GmbH)",
                sponsor: "FS IT-Systeme GmbH",
                url: "https://speed.fs-it.systems/",
                ping: null,
                pingUrl: "https://speed.fs-it.systems/backend/empty.php",
            },
            {
                id: 79,
                name: "Prague, Czech Republic (CESNET)",
                sponsor: "CESNET",
                url: "https://speedtest.cesnet.cz/",
                ping: null,
                pingUrl: "https://speedtest.cesnet.cz/backend/empty.php",
            },
        ]);
        const mixed = normalizeServers([
            { id: 1, name: "ok", server: "https://a/" },
            { id: "nope", name: "bad id", server: "https://b/" },
            { id: 2, name: 5, server: "https://c/" },
            "junk",
            null,
            { name: "no server url", server: 3 },
        ]);
        expect(mixed).toEqual([
            {
                id: 1,
                name: "ok",
                sponsor: "",
                url: "https://a/",
                ping: null,
                pingUrl: "https://a/empty.php",
            },
        ]);
        expect(normalizeServers({})).toEqual([]);
        expect(normalizeServers(null)).toEqual([]);
    });

    test("sortServersByPing: measured ascending, unmeasured keep order last", () => {
        const mk = (id: number, ping: number | null) => ({
            id,
            name: `s${id}`,
            sponsor: "",
            url: `https://s${id}/`,
            ping,
            pingUrl: `https://s${id}/empty.php`,
        });
        expect(sortServersByPing([mk(1, 90), mk(2, null), mk(3, 12), mk(4, null)]))
            .toEqual([mk(3, 12), mk(1, 90), mk(2, null), mk(4, null)]);
        // Stable for equal pings.
        expect(sortServersByPing([mk(1, 5), mk(2, 5)]).map((s) => s.id)).toEqual([
            1, 2,
        ]);
    });

    test("measurePings fills RTT, keeps failures null, respects the budget", async () => {
        let t = 0;
        const mk = (id: number, pingUrl: string): SpeedtestServer => ({
            id,
            name: `s${id}`,
            sponsor: "",
            url: pingUrl,
            ping: null,
            pingUrl,
        });
        const servers = [
            mk(1, "https://a"),
            mk(2, "https://b"),
            mk(3, "https://slow"),
        ];
        await measurePings(servers, {
            now: () => (t += 1),
            fetch: async (url) => {
                if (String(url).includes("slow")) throw new Error("down");
                t += 40; // 40 ms round trip
            },
        });
        // Shared clock: the RTT is ≥ the probe time, exact value up to skew.
        expect(servers[0].ping).toBeGreaterThanOrEqual(40);
        expect(servers[1].ping).toBeGreaterThanOrEqual(40);
        expect(servers[2].ping).toBeNull();
    });

    test("get() serves the list sorted by measured ping", async () => {
        await withTempDir(async (dir) => {
            const list = new ServerListCache({
                dir,
                fetch: async () =>
                    (await readFixture("servers-sample.json")).trim(),
                ping: async (servers) => {
                    for (const s of servers)
                        // Deterministic fake RTT: id 79 is faster than 105.
                        s.ping = s.id === 79 ? 11 : 42;
                },
                now: () => 0,
            });
            await list.refresh(); // land the cache first
            const res = await list.get();
            expect(res.available).toBeTrue();
            expect(res.servers.map((s) => s.id)).toEqual([79, 105]);
            expect(res.servers[0].ping).toBe(11);
        });
    });

    test("TTL: no refetch before 1 h, refetch after", async () => {
        await withTempDir(async (dir) => {
            let nowMs = 0;
            let fetched = 0;
            const list = new ServerListCache({
                dir,
                fetch: async () => {
                    fetched++;
                    return (await readFixture("servers-sample.json")).trim();
                },
                ping: async () => {},
                now: () => nowMs,
            });
            const first = await list.get(); // stale → background refresh kicked
            expect(first.available).toBeFalse(); // cache not written yet
            expect(first.refreshing).toBeTrue();
            await list.refresh(); // await the in-flight refresh to land
            expect(fetched).toBe(1);
            expect((await list.get()).available).toBeTrue();
            nowMs = 30 * 60 * 1000; // 30 min
            expect((await list.get()).refreshing).toBeFalse(); // still fresh
            expect(fetched).toBe(1);
            nowMs = 61 * 60 * 1000; // 61 min
            await list.get(); // stale → kicks a refresh
            await list.refresh();
            expect(fetched).toBe(2); // refetched
            expect(list.hasServer(105)).toBeTrue();
            expect(list.hasServer(999)).toBeFalse();
        });
    });

    test("fetch failure with no cache → available: false", async () => {
        const dir = await mkdtemp(join(tmpdir(), "st-"));
        try {
            const list = new ServerListCache({
                dir,
                fetch: async () => {
                    throw new Error("offline");
                },
                now: () => 0,
            });
            const res = await list.get();
            expect(res.available).toBeFalse();
            expect(res.servers).toEqual([]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("refresh persists the raw array (for --local-json)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "st-"));
        try {
            const raw = (await readFixture("servers-sample.json")).trim();
            const list = new ServerListCache({
                dir,
                fetch: async () => raw,
                now: () => 0,
            });
            await list.refresh();
            const onDisk = (await Bun.file(join(dir, "servers.json")).text()).trim();
            expect(JSON.parse(onDisk)).toEqual(JSON.parse(raw));
            expect(list.cacheInfo().exists).toBeTrue();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("concurrent refreshes are single-flight", async () => {
        let fetched = 0;
        let release: () => void;
        const gate = new Promise<void>((res) => {
            release = res;
        });
        await withTempDir(async (dir) => {
            const list = new ServerListCache({
                dir,
                fetch: async () => {
                    fetched++;
                    await gate;
                    return (await readFixture("servers-sample.json")).trim();
                },
                ping: async () => {},
                now: () => 0,
            });
            const done = Promise.all([list.refresh(), list.refresh()]);
            await Bun.sleep(20); // both calls in flight before release
            expect(fetched).toBe(1); // single-flight
            release!();
            await done;
        });
    });
});

// ── cli resolver: probe + resolution order ───────────────────

async function writeFakeCli(dir: string, fresh: boolean): Promise<string> {
    const bin = join(dir, "librespeed-cli");
    await writeFile(
        bin,
        fresh
            ? "#!/bin/sh\necho 'usage: --json-stream ...'\n"
            : "#!/bin/sh\necho 'usage: --json ...'\n",
    );
    await chmod(bin, 0o755);
    return bin;
}

describe("cli resolver (probe + resolution order)", () => {
    test("probe: master build true, release v1.0.14-shaped false, missing false", async () => {
        await withTempDir(async (dir) => {
            const fresh = await writeFakeCli(dir, true);
            const stale = join(dir, "stale");
            await writeFile(
                stale,
                "#!/bin/sh\necho 'usage: --json ...'\n",
            );
            await chmod(stale, 0o755);
            expect(await probeJsonStreamSupport(fresh)).toBe(true);
            expect(await probeJsonStreamSupport(stale)).toBe(false);
            expect(
                await probeJsonStreamSupport(join(dir, "does-not-exist")),
            ).toBe(false);
        });
    });

    test("a fresh binary in cwd is preferred over a download", async () => {
        await withTempDir(async (dataDir) => {
            const cwd = await mkdtemp(join(tmpdir(), "speedtest-cwd-"));
            const bin = await writeFakeCli(cwd, true);
            const originalCwd = process.cwd();
            let fetched = 0;
            try {
                process.chdir(cwd);
                const resolver = new CliResolver({
                    dir: dataDir,
                    fetch: async () => {
                        fetched++;
                        return new Uint8Array();
                    },
                    uname: async () => "x86_64",
                });
                expect(await resolver.resolve()).toBe(bin);
                expect(fetched).toBe(0); // no download needed
            } finally {
                process.chdir(originalCwd);
                await rm(cwd, { recursive: true, force: true });
            }
        });
    });

    test("a stale binary (no --json-stream) fails with a clear diagnostic", async () => {
        await withTempDir(async (dataDir) => {
            const cwd = await mkdtemp(join(tmpdir(), "speedtest-cwd-"));
            await writeFakeCli(cwd, false);
            const originalCwd = process.cwd();
            try {
                process.chdir(cwd);
                const resolver = new CliResolver({
                    dir: dataDir,
                    uname: async () => "x86_64",
                });
                await expect(resolver.resolve()).rejects.toThrow(
                    "does not support --json-stream",
                );
            } finally {
                process.chdir(originalCwd);
                await rm(cwd, { recursive: true, force: true });
            }
        });
    });
});

// ── interface enumeration ────────────────────────────────────

describe("interface enumeration", () => {
    test("/sys/class/net + os join (wwx modem appears with address)", async () => {
        const out = await listInterfaces({
            sysNames: Promise.resolve(["lo", "wwx001e101f0000", "eth0"]),
            readState: async (name) => (name === "lo" ? "down" : "up"),
            osInfo: () =>
                ({
                    wwx001e101f0000: [{ address: "10.0.0.2", family: "IPv4", internal: false }],
                    eth0: [{ address: "192.168.1.10", family: "IPv4", internal: false }],
                }) as unknown as ReturnType<typeof networkInterfaces>,
        });
        const wwx = out.find((i) => i.name === "wwx001e101f0000");
        expect(wwx).toEqual({
            name: "wwx001e101f0000",
            addresses: ["10.0.0.2"],
            up: true,
        });
        // /sys names are sorted; eth0 sorts before wwx… and both are up.
        expect(pickDefaultInterface(out)).toBe("eth0");
    });

    test("os-only fallback when /sys is missing", async () => {
        const out = await listInterfaces({
            sysNames: Promise.reject(new Error("no /sys")),
            osInfo: () =>
                ({
                    en0: [{ address: "192.168.0.9", family: "IPv4", internal: false }],
                }) as unknown as ReturnType<typeof networkInterfaces>,
        });
        expect(out).toEqual([
            { name: "en0", addresses: ["192.168.0.9"], up: true },
        ]);
    });

    test("default pick skips loopback and down interfaces", () => {
        expect(
            pickDefaultInterface([
                { name: "lo", addresses: ["127.0.0.1"], up: true },
                { name: "eth0", addresses: ["10.0.0.1"], up: false },
                { name: "wwan0", addresses: ["100.64.0.4"], up: true },
            ]),
        ).toBe("wwan0");
        expect(pickDefaultInterface([])).toBeNull();
    });
});

// ── ARM asset mapping ────────────────────────────────────────

describe("release asset arch mapping", () => {
    test.each([
        ["x86_64", "amd64"],
        ["i686", "386"],
        ["i386", "386"],
        ["aarch64", "arm64"],
        ["armv8l", "armv7"],
        ["armv7l", "armv7"],
        ["armv6l", "armv6"],
    ] as [string, string][])(
        "%s → %s",
        (uname, want) => {
            expect(linuxArchAsset(uname)).toBe(want);
        },
    );
    test("unknown arm arches fail", () => {
        expect(() => linuxArchAsset("armv5l")).toThrow(/unsupported/);
        expect(() => linuxArchAsset("riscv64")).toThrow(/unsupported/);
    });

    test("process arch arm + uname armv6l → armv6 asset (not armv7)", () => {
        // spec: {process.arch === 'arm' + uname -m === 'armv6l' → armv6}
        expect(linuxArchAsset("armv6l")).toBe("armv6");
    });

    test("pickAsset finds the linux tarball; throws when absent", () => {
        const assets = [
            { name: "checksums.txt", browser_download_url: "https://x/checksums.txt" },
            { name: "librespeed-cli_1.0.14_linux_amd64.tar.gz", browser_download_url: "https://x/linux-amd64" },
            { name: "librespeed-cli_1.0.14_darwin_amd64.tar.gz", browser_download_url: "https://x/darwin-amd64" },
            { name: "librespeed-cli_1.0.14_linux_armv6.tar.gz", browser_download_url: "https://x/linux-armv6" },
        ];
        expect(pickAsset(assets, "x86_64").name).toBe(
            "librespeed-cli_1.0.14_linux_amd64.tar.gz",
        );
        expect(pickAsset(assets, "armv6l").url).toBe("https://x/linux-armv6");
        expect(() => pickAsset(assets, "armv7l")).toThrow(/no armv7 release asset/);
    });
});

// ── instantaneous Mbps ───────────────────────────────────────

describe("instantaneous Mbps (spec §7.3)", () => {
    test("downward trend sample", () => {
        // 10.71 @1s → 8.51 @2s: inst = (17.02 − 10.71) / 1
        expect(instantMbps({ mbps: 10.71, seconds: 1 }, { mbps: 8.51, seconds: 2 })).toBeCloseTo(6.31, 2);
        expect(instantMbps(null, { mbps: 10.71, seconds: 1 })).toBe(0);
        // clamp negative / zero-dt → 0
        expect(instantMbps({ mbps: 9, seconds: 2 }, { mbps: 5, seconds: 2 })).toBe(0);
        expect(instantMbps({ mbps: 1, seconds: 2 }, { mbps: 0.5, seconds: 1 })).toBe(0);
    });
});

// ── run manager ──────────────────────────────────────────────

interface FakeSpawn {
    calls: { bin: string; args: string[]; env: Record<string, string> }[];
    proc: ReturnType<typeof makeFakeProc>["proc"];
    resolveExit: (code: number | null) => void;
}

function makeFakeProc(opts: {
    stdout: string;
    stderr: string;
    onKill?: (signal: string) => void;
}) {
    let resolveExit: (code: number | null) => void;
    const exited = new Promise<number | null>((res) => {
        resolveExit = res;
    });
    const proc = {
        pid: 42424,
        exitCode: null as number | null,
        exited,
        stdout: new Response(opts.stdout).body,
        stderr: new Response(opts.stderr).body,
        kill: (signal: string) => opts.onKill?.(String(signal)),
    };
    return {
        proc: proc as unknown as Bun.Subprocess,
        resolveExit: (code: number | null) => {
            proc.exitCode = code;
            resolveExit(code);
        },
    };
}

async function makeFixtureList(dir: string): Promise<ServerListCache> {
    const list = new ServerListCache({
        dir,
        fetch: async () => (await readFixture("servers-sample.json")).trim(),
        now: () => 0,
    });
    await list.refresh(); // awaited: get() only kicks a *background* refresh
    return list;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "speedtest-test-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const RESULT_LINE =
    '{"event":"result","reports":[{"timestamp":"2026-11-14T07:05:11+01:00","server":{"name":"Frankfurt, Germany (FS IT-Systeme GmbH)","url":"https://speed.fs-it.systems/"},"client":{"ip":"46.135.89.151","hostname":"","city":"","region":"","country":"CZ","loc":"","org":"Vodafone CZ","postal":"","timezone":""},"bytes_sent":1,"bytes_received":2,"ping":31.46,"jitter":6.25,"upload":0.27,"download":5.13,"share":"","tls":{"version":"TLS 1.3","cipher":"X"}}]}';

function makeManager(opts: {
    dir: string;
    list: ServerListCache;
    stdout?: string;
    stderr?: string;
    onKill?: (s: string) => void;
}): { manager: SpeedtestRunManager; spawn: FakeSpawn; events: { event: string; data: unknown }[] } {
    const events: { event: string; data: unknown }[] = [];
    const fake = makeFakeProc({
        stdout: opts.stdout ?? "",
        stderr: opts.stderr ?? "",
        onKill: opts.onKill,
    });
    const spawn: FakeSpawn = { calls: [], proc: fake.proc, resolveExit: fake.resolveExit };
    const manager = new SpeedtestRunManager({
        resolveBin: async () => "/fake/librespeed-cli",
        list: opts.list,
        emit: (event, data) => events.push({ event, data }),
        log: () => {},
        spawn: (bin, args, env) => {
            spawn.calls.push({ bin, args, env });
            return spawn.proc;
        },
    });
    return { manager, spawn, events };
}

describe("run manager", () => {
    test("last result: null before, set after success, overwritten", async () => {
        await withTempDir(async (dir) => {
            const list = await makeFixtureList(dir);
            const { manager, spawn, events } = makeManager({
                dir,
                list,
                stdout: `{"event":"phase","phase":"ping"}\n${RESULT_LINE}\n`,
            });
            expect(manager.lastResult).toBeNull();
            const { runId } = await manager.start({
                serverId: 105,
                interface: "wwx001e101f0000",
                duration: null,
            });
            spawn.resolveExit(0);
            await Bun.sleep(30);
            expect(manager.lastResult).not.toBeNull();
            expect(manager.lastResult?.runId).toBe(runId);
            expect(manager.lastResult?.result.download).toBe(5.13);
            expect(manager.lastResult?.serverId).toBe(105);
            expect(manager.lastResult?.interface).toBe("wwx001e101f0000");
            // envelope order: result before exit
            const kinds = events.map((e) => (e.data as { kind: string }).kind);
            expect(kinds.indexOf("result")).toBeLessThan(kinds.indexOf("exit"));
            // overwrite with a second run
            const fake2 = makeFakeProc({
                stdout: `{"event":"result","reports":[{"timestamp":"t2","server":{"name":"Prague, Czech Republic (CESNET)","url":"u"},"client":{"ip":"1.2.3.4","hostname":"","city":"","region":"","country":"CZ","loc":"","org":"Ops","postal":"","timezone":""},"bytes_sent":1,"bytes_received":2,"ping":10,"jitter":1,"upload":7,"download":9.5,"share":""}]}\n`,
                stderr: "",
            });
            const spawn2 = {
                calls: [] as FakeSpawn["calls"],
                proc: fake2.proc,
                resolveExit: fake2.resolveExit,
            };
            const manager2 = new SpeedtestRunManager({
                resolveBin: async () => "/fake/librespeed-cli",
                list,
                emit: () => {},
                log: () => {},
                spawn: (b, a, e) => {
                    spawn2.calls.push({ bin: b, args: a, env: e });
                    return spawn2.proc;
                },
            });
            void manager2.start({ serverId: 79, interface: null, duration: null });
            fake2.resolveExit(0);
            await Bun.sleep(30);
            expect(manager2.lastResult?.result.download).toBe(9.5);
        });
    });

    test("argv through the manager: cache present → --local-json; env tag set", async () => {
        await withTempDir(async (dir) => {
            const list = await makeFixtureList(dir);
            const { manager, spawn } = makeManager({ dir, list, stdout: "" });
            void manager.start({ serverId: 105, interface: null, duration: null });
            spawn.resolveExit(0);
            await Bun.sleep(20);
            expect(spawn.calls).toHaveLength(1);
            const [call] = spawn.calls;
            expect(call.args).toEqual([
                "--json-stream",
                "--local-json",
                list.path,
                "--server",
                "105",
            ]);
            expect(call.env.IRLCTRL_SPEEDTEST).toBe("1");
        });
    });

    test("no cache + server picked → --server without --local-json", async () => {
        await withTempDir(async (dir) => {
            const list = new ServerListCache({
                dir,
                fetch: async () => {
                    throw new Error("offline");
                },
                now: () => 0,
            });
            await list.get(); // fails; no cache on disk
            const { manager, spawn } = makeManager({ dir, list, stdout: "" });
            void manager.start({ serverId: 105, interface: null, duration: null });
            spawn.resolveExit(0);
            await Bun.sleep(20);
            expect(spawn.calls[0].args).toEqual(["--json-stream", "--server", "105"]);
        });
    });

    test("stale server id → 409 server_not_in_list, no spawn", async () => {
        await withTempDir(async (dir) => {
            const list = await makeFixtureList(dir); // has [105, 79]
            const { manager, spawn } = makeManager({ dir, list, stdout: "" });
            await expect(
                manager.start({ serverId: 999, interface: null, duration: null }),
            ).rejects.toMatchObject({
                code: 409,
                message: "server_not_in_list",
            });
            expect(spawn.calls).toHaveLength(0);
        });
    });

    test("double run → 409 already_running", async () => {
        await withTempDir(async (dir) => {
            const list = await makeFixtureList(dir);
            const { manager, spawn } = makeManager({ dir, list, stdout: "" });
            void manager.start({ serverId: null, interface: null, duration: null });
            await Bun.sleep(10);
            await expect(
                manager.start({ serverId: null, interface: null, duration: null }),
            ).rejects.toMatchObject({ code: 409, message: "already_running" });
            expect(spawn.calls).toHaveLength(1);
            spawn.resolveExit(0);
            await Bun.sleep(20);
        });
    });

    test("cancel → SIGTERM, then error + exit envelopes", async () => {
        await withTempDir(async (dir) => {
            const list = await makeFixtureList(dir);
            const kills: string[] = [];
            const { manager, spawn, events } = makeManager({
                dir,
                list,
                stdout: '{"event":"phase","phase":"ping"}\n',
                onKill: (s) => kills.push(s),
            });
            const { runId } = await manager.start({
                serverId: null,
                interface: null,
                duration: null,
            });
            manager.cancel(runId);
            expect(kills).toContain("SIGTERM");
            spawn.resolveExit(143);
            await Bun.sleep(30);
            const kinds = events.map((e) => (e.data as { kind: string }).kind);
            expect(kinds.indexOf("error")).toBeLessThan(kinds.indexOf("exit"));
            const error = events.find(
                (e) => (e.data as { kind: string }).kind === "error",
            )?.data as { data: { message: string } };
            expect(error?.data?.message).toBe("Run cancelled");
        });
    });

    test("non-zero exit → error envelope with stderr tail, lastResult untouched", async () => {
        await withTempDir(async (dir) => {
            const list = await makeFixtureList(dir);
            const { manager, spawn, events } = makeManager({
                dir,
                list,
                stdout: "",
                stderr: 'Error: Server not found\n',
            });
            void manager.start({ serverId: 105, interface: null, duration: null });
            spawn.resolveExit(1);
            await Bun.sleep(30);
            expect(manager.lastResult).toBeNull();
            const error = events.find(
                (e) => (e.data as { kind: string }).kind === "error",
            )?.data as { data: { message: string; stderrTail: string } };
            expect(error?.data?.message).toBe(
                "Selected server is no longer available",
            );
            expect(error?.data?.stderrTail).toContain("Server not found");
        });
    });

    test("stop() kills the running child", async () => {
        await withTempDir(async (dir) => {
            const list = await makeFixtureList(dir);
            const kills: string[] = [];
            const { manager, spawn } = makeManager({
                dir,
                list,
                stdout: "",
                onKill: (s) => kills.push(s),
            });
            void manager.start({ serverId: null, interface: null, duration: null });
            await Bun.sleep(10);
            const stopping = manager.stop(); // kills, then awaits the exit
            expect(kills).toContain("SIGTERM");
            spawn.resolveExit(143);
            await stopping;
        });
    });
});

// ── hard timeout ─────────────────────────────────────────────

describe("live CLI (optional; INTEGRATION_SPEEDTEST=1)", () => {
    test("runs against a known server and reports it", async () => {
        if (!process.env.INTEGRATION_SPEEDTEST) return; // off by default
        const dir = await mkdtemp(join(tmpdir(), "speedtest-live-"));
        try {
            const list = new ServerListCache({ dir }); // real fetch
            await list.refresh();
            let exitCode: number | null = null;
            const exited = new Promise<number | null>((res) => {
                exitResolver = res;
            });
            const manager = new SpeedtestRunManager({
                resolveBin: () => new CliResolver({ dir }).resolve(),
                list,
                emit: (_event, data) => {
                    const env = data as {
                        kind: string;
                        data?: { code: number | null };
                    };
                    if (env.kind === "exit") exitResolver(env.data?.code ?? null);
                },
                log: () => {},
            });
            void manager.start({ serverId: 105, interface: null, duration: null });
            exitCode = await Promise.race([
                exited,
                new Promise<number | null>((res) =>
                    setTimeout(() => res(null), 180_000),
                ),
            ]);
            expect(exitCode).toBe(0);
            expect(manager.lastResult?.result.server.name).toBe(
                "Frankfurt, Germany (FS IT-Systeme GmbH)",
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }, 240_000);
});

let exitResolver: (code: number | null) => void = () => {};

describe("hard timeout formula", () => {
    test("duration × 3 + 30 s, 15 s floor on the duration", () => {
        expect(hardTimeoutMs(null)).toBe(75_000);
        expect(hardTimeoutMs(30)).toBe(120_000);
        expect(hardTimeoutMs(5)).toBe(75_000); // floored at 15 s
    });
});
