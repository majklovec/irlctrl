import { describe, expect, test } from "bun:test";
import {
    IF_NAME_LEN,
    IFF_NO_PI,
    IFF_TUN,
    TUNSETIFF,
    buildTunsetName,
    openTun,
    readTunsetName,
    resolveBinary,
    runCmd,
} from "../src/tun_linux";

describe("tun_linux.ts — TUNSETIFF struct layout", () => {
    test("buildTunsetName pads to 16 bytes with a NUL terminator", () => {
        const buf = buildTunsetName("moblink0");
        expect(buf.length).toBe(IF_NAME_LEN);
        // First bytes spell the name, then NUL, then zeros.
        expect(new TextDecoder().decode(buf.subarray(0, 8))).toBe("moblink0");
        expect(buf[8]).toBe(0);
        // Every byte after the name is zero.
        for (let i = 8; i < IF_NAME_LEN; i++) expect(buf[i]).toBe(0);
    });

    test("buildTunsetName produces the expected byte pattern for a known name", () => {
        // "eth0" -> 65 74 68 30 00 00 00 00 00 00 00 00 00 00 00 00
        const buf = buildTunsetName("eth0");
        expect([...buf.subarray(0, 5)]).toEqual([0x65, 0x74, 0x68, 0x30, 0x00]);
        expect([...buf].slice(5).every((b) => b === 0)).toBe(true);
    });

    test("readTunsetName round-trips buildTunsetName", () => {
        for (const name of ["moblink0", "eth0", "vif10", "a"])
            expect(readTunsetName(buildTunsetName(name))).toBe(name);
    });

    test("buildTunsetName rejects a name at or over 16 chars", () => {
        expect(() => buildTunsetName("x".repeat(16))).toThrow();
        expect(() => buildTunsetName("x".repeat(15) + "x")).toThrow();
        // 15 chars is the max (leaves room for the NUL).
        expect(buildTunsetName("x".repeat(15)).length).toBe(IF_NAME_LEN);
    });
});

describe("tun_linux.ts — constants", () => {
    test("expected ioctl/flag values", () => {
        expect(IFF_TUN).toBe(0x0001);
        expect(IFF_NO_PI).toBe(0x1000);
        // _IOW('T', 202, int) — verified against <linux/if_tun.h>.
        expect(TUNSETIFF).toBe(0x400454ca);
        // The combined flag set the device is opened with.
        expect(IFF_TUN | IFF_NO_PI).toBe(0x1001);
    });
});

describe("tun_linux.ts — openTun guard", () => {
    test("openTun rejects non-Linux platforms", async () => {
        const before = process.platform;
        const desc = Object.getOwnPropertyDescriptor(
            process,
            "platform",
        )!;
        Object.defineProperty(process, "platform", {
            value: "darwin",
            configurable: true,
        });
        try {
            await expect(openTun("moblink0")).rejects.toThrow(/Linux/);
        } finally {
            Object.defineProperty(process, "platform", desc);
        }
        expect(process.platform).toBe(before);
    });
});

describe("tun_linux.ts — runCmd / resolveBinary (spawn never hangs)", () => {
    test("resolveBinary finds a common system binary as an absolute path", () => {
        const p = resolveBinary("sh");
        expect(p.startsWith("/")).toBe(true);
        expect(p.endsWith("/sh")).toBe(true);
    });

    test("resolveBinary returns the bare name when nothing matches", () => {
        // A name that exists nowhere on the system.
        expect(
            resolveBinary("definitely-not-a-real-binary-xyz-12345"),
        ).toBe("definitely-not-a-real-binary-xyz-12345");
    });

    test("runCmd resolves with stdout on exit 0", async () => {
        const out = await runCmd("echo", ["hello-moblink"]);
        expect(out.trim()).toBe("hello-moblink");
    });

    test("runCmd rejects (does not hang) when the binary cannot be spawned", async () => {
        // Regression: a `close`-only handler never settles on a spawn failure
        // (ENOENT), so this hung and the enclosing RPC timed out. Now it must
        // reject promptly with an actionable message.
        await expect(
            runCmd("definitely-not-a-real-binary-xyz-12345", ["x"]),
        ).rejects.toThrow(/failed to start/);
    });

    test("runCmd rejects with the exit code on a non-zero exit", async () => {
        await expect(runCmd("sh", ["-c", "exit 3"])).rejects.toThrow(
            /exited 3/,
        );
    });
});
