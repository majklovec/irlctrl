/*
 * 3GPP network scan parsing and the setup parameter validators. The entry
 * string comes from `mmcli --3gpp-scan --output-keyvalue` in two eras —
 * modern: "operator-code: 23003, operator-name: Vodafone CZ, …" / legacy:
 * "505,01,status: current,access-tech: lte,operator-name: Telstra". The
 * validators gate the `modems.setup` request before it reaches nmcli/mmcli.
 */
import { describe, expect, test } from "bun:test";
import {
    bindModemManager,
    parseModeCombo,
    parseScanNetworkEntry,
    pruneOrphanGsmConns,
    scanMobileNetworks,
    setModemModes,
    setupToGsmFields,
} from "../client/modules/modems/modems";
import type { ModuleCore } from "../client/backend/module_core";
import {
    ApiError,
    optionalApn,
    optionalBoolean,
    optionalPassword,
    optionalPlmn,
    optionalRat,
    optionalRatList,
    optionalUsername,
} from "../shared/params";

/** A ModuleCore stub whose `run` is supplied per-test; records every call. */
function coreStub(
    run: (cmd: string, args: readonly string[]) => Promise<string>,
): { core: ModuleCore; calls: string[] } {
    const calls: string[] = [];
    return {
        core: {
            run: (async (cmd: string, args: readonly string[]) => {
                calls.push(` ${cmd} ${args.join(" ")}`);
                return run(cmd, args);
            }) as never,
            state: { settings: {}, autostart: false, data: {} },
            saveState: async () => {},
        } as unknown as ModuleCore,
        calls,
    };
}

describe("parseScanNetworkEntry", () => {
    test("parses the modern all-key-value format (mmcli 1.20+)", () => {
        // Live capture from mmcli 1.25 --3gpp-scan --output-keyvalue.
        expect(
            parseScanNetworkEntry(
                "operator-code: 23003, operator-name: Vodafone CZ, access-technologies: lte, availability: current",
            ),
        ).toEqual({
            plmn: "230,03",
            plmnId: "23003",
            status: "current",
            accessTech: "lte",
            operatorName: "Vodafone CZ",
        });
    });

    test("keeps a multi-value access-technologies field intact", () => {
        expect(
            parseScanNetworkEntry(
                "operator-code: 23002, operator-name: O2 - CZ, access-technologies: gsm, lte, availability: available",
            ),
        ).toEqual({
            plmn: "230,02",
            plmnId: "23002",
            status: "available",
            accessTech: "gsm, lte",
            operatorName: "O2 - CZ",
        });
    });

    test("splits the positional PLMN of the legacy format", () => {
        // Older mmcli: "MCC,MNC,status: …,access-tech: …,operator-name: …".
        expect(
            parseScanNetworkEntry(
                "505,01,status: current,access-tech: lte,operator-name: Telstra",
            ),
        ).toEqual({
            plmn: "505,01",
            plmnId: "50501",
            status: "current",
            accessTech: "lte",
            operatorName: "Telstra",
        });
    });

    test("handles a 3-digit MNC and a missing operator-name", () => {
        expect(
            parseScanNetworkEntry("208,175,status: available,access-tech: gsm"),
        ).toEqual({
            plmn: "208,175",
            plmnId: "208175",
            status: "available",
            accessTech: "gsm",
        });
    });

    test("also accepts space-separated fields (older mmcli builds)", () => {
        expect(
            parseScanNetworkEntry(
                "505,01, status: current, access-tech: lte, operator-name: Telstra",
            ),
        ).toEqual({
            plmn: "505,01",
            plmnId: "50501",
            status: "current",
            accessTech: "lte",
            operatorName: "Telstra",
        });
    });

    test("rejects garbage", () => {
        expect(parseScanNetworkEntry("")).toBeNull();
        expect(parseScanNetworkEntry("status: current")).toBeNull();
    });
});

describe("scanMobileNetworks", () => {
    test("parses a real `--3gpp-scan --output-keyvalue` capture end to end", async () => {
        // Exact stdout from `mmcli --timeout=240 -m 2 --3gpp-scan
        // --output-keyvalue` on the device. This pins the whole pipeline
        // (parseKeyvalue -> `value[N]` filter -> per-entry parse), which is
        // where an empty select regressed: the array lands under
        // `modem.3gpp.scan-networks.value[…]`, not `…scan-networks`.
        const stdout = [
            "modem.3gpp.scan-networks.length   : 2",
            "modem.3gpp.scan-networks.value[1] : operator-code: 23003, operator-name: Vodafone CZ, access-technologies: lte, availability: current",
            "modem.3gpp.scan-networks.value[2] : operator-code: 23002, operator-name: O2 - CZ, access-technologies: lte, availability: available",
        ].join("\n");
        bindModemManager({
            run: (async (
                _cmd: string,
                args: readonly string[],
            ): Promise<string> =>
                args.includes("--3gpp-scan") ? stdout : "") as never,
        } as unknown as ModuleCore);

        expect(await scanMobileNetworks(2)).toEqual([
            {
                plmn: "230,03",
                plmnId: "23003",
                status: "current",
                accessTech: "lte",
                operatorName: "Vodafone CZ",
            },
            {
                plmn: "230,02",
                plmnId: "23002",
                status: "available",
                accessTech: "lte",
                operatorName: "O2 - CZ",
            },
        ]);
    });

    test("retries on a transient timeout and returns once a sweep succeeds", async () => {
        let scans = 0;
        const ok =
            "modem.3gpp.scan-networks.value[1] : operator-code: 23003, operator-name: Vodafone CZ, access-technologies: lte, availability: current";
        bindModemManager({
            run: (async (
                _cmd: string,
                args: readonly string[],
            ): Promise<string> => {
                if (!args.includes("--3gpp-scan")) return "";
                scans += 1;
                return scans >= 2 ? ok : ""; // first pass: empty sweep
            }) as never,
        } as unknown as ModuleCore);

        expect(await scanMobileNetworks(2)).toEqual([
            {
                plmn: "230,03",
                plmnId: "23003",
                status: "current",
                accessTech: "lte",
                operatorName: "Vodafone CZ",
            },
        ]);
        expect(scans).toBe(2);
    });
});

describe("optionalPlmn", () => {
    test("normalizes the dotted form and accepts digits", () => {
        expect(optionalPlmn({ plmn: "505,01" })).toBe("50501");
        expect(optionalPlmn({ plmn: "50501" })).toBe("50501");
        expect(optionalPlmn({ plmn: " 208-175 " })).toBe("208175");
    });

    test("absent and blank stay undefined", () => {
        expect(optionalPlmn({})).toBeUndefined();
        expect(optionalPlmn({ plmn: "" })).toBeUndefined();
        expect(optionalPlmn({ plmn: null })).toBeUndefined();
    });

    test("rejects anything that is not an MCC/MNC", () => {
        for (const bad of ["505", "5051", "5050111", "50a,01", "abc"])
            expect(() => optionalPlmn({ plmn: bad })).toThrow(ApiError);
    });
});

describe("optionalApn", () => {
    test("trims and accepts carrier APNs", () => {
        expect(optionalApn({ apn: " internet " })).toBe("internet");
        expect(optionalApn({ apn: "internet" })).toBe("internet");
        expect(optionalApn({ apn: "broadband" })).toBe("broadband");
        expect(optionalApn({ apn: "proxy:10.0.0.1:8080" })).toBe(
            "proxy:10.0.0.1:8080",
        );
        expect(optionalApn({ apn: "isp-1_net" })).toBe("isp-1_net");
    });

    test("absent and blank stay undefined", () => {
        expect(optionalApn({})).toBeUndefined();
        expect(optionalApn({ apn: "   " })).toBeUndefined();
        expect(optionalApn({ apn: null })).toBeUndefined();
    });

    test("rejects whitespace and control characters", () => {
        for (const bad of ["in ternet", "tel;co", "a".repeat(65), 42])
            expect(() => optionalApn({ apn: bad })).toThrow(ApiError);
    });
});

describe("optionalUsername", () => {
    test("trims and accepts carrier usernames", () => {
        expect(optionalUsername({ username: " user " })).toBe("user");
        expect(optionalUsername({ username: "a.b_c@d-e" })).toBe("a.b_c@d-e");
    });
    test("absent and blank stay undefined", () => {
        expect(optionalUsername({})).toBeUndefined();
        expect(optionalUsername({ username: "" })).toBeUndefined();
        expect(optionalUsername({ username: null })).toBeUndefined();
    });
    test("rejects bad values", () => {
        for (const bad of ["a b", "a".repeat(65), 42])
            expect(() => optionalUsername({ username: bad })).toThrow(ApiError);
    });
});

describe("optionalPassword", () => {
    test("absent stays undefined, an empty string clears it", () => {
        expect(optionalPassword({})).toBeUndefined();
        expect(optionalPassword({ password: "" })).toBe("");
        expect(optionalPassword({ password: "s3cret" })).toBe("s3cret");
    });
    test("rejects non-strings", () => {
        expect(() => optionalPassword({ password: 42 })).toThrow(ApiError);
    });
});

describe("optionalBoolean", () => {
    test("absent stays undefined, booleans pass through", () => {
        expect(optionalBoolean({}, "allowRoaming")).toBeUndefined();
        expect(optionalBoolean({ allowRoaming: true }, "allowRoaming")).toBe(
            true,
        );
        expect(optionalBoolean({ allowRoaming: false }, "allowRoaming")).toBe(
            false,
        );
    });
    test("rejects non-booleans", () => {
        expect(() => optionalBoolean({ allowRoaming: "yes" }, "allowRoaming")).toThrow(
            ApiError,
        );
    });
});

describe("optionalRatList / optionalRat", () => {
    test("accepts a list of RATs", () => {
        expect(optionalRatList({ allowedModes: ["gsm", "lte"] })).toEqual([
            "gsm",
            "lte",
        ]);
        expect(optionalRatList({})).toBeUndefined();
    });
    test("rejects an unknown RAT or a non-array", () => {
        expect(() => optionalRatList({ allowedModes: ["gsm", "5g"] })).toThrow(
            ApiError,
        );
        expect(() => optionalRatList({ allowedModes: "gsm" })).toThrow(ApiError);
    });
    test("optionalRat accepts a single RAT, empty/auto are undefined", () => {
        expect(optionalRat({ preferredMode: "lte" })).toBe("lte");
        expect(optionalRat({})).toBeUndefined();
        expect(optionalRat({ preferredMode: "auto" })).toBeUndefined();
        expect(optionalRat({ preferredMode: "" })).toBeUndefined();
        expect(() => optionalRat({ preferredMode: "gsmm" })).toThrow(ApiError);
    });
});

describe("setupToGsmFields", () => {
    test("maps apn/username/password/roaming/plmn to gsm.* fields", () => {
        expect(
            setupToGsmFields({
                apn: "internet",
                username: "user",
                password: "pw",
                allowRoaming: false,
                plmn: "23003",
            }),
        ).toEqual({
            "gsm.apn": "internet",
            "gsm.username": "user",
            "gsm.password": "pw",
            "gsm.password-flags": "0",
            "gsm.home-only": "yes",
            "gsm.network-id": "",
        });
    });
    test("a blank password uses hidden password-flags", () => {
        expect(setupToGsmFields({ password: "" })).toEqual({
            "gsm.password": "",
            "gsm.password-flags": "4",
        });
    });
    test("roaming on allows the PLMN pin in network-id", () => {
        expect(setupToGsmFields({ allowRoaming: true, plmn: "23003" })).toEqual({
            "gsm.home-only": "no",
            "gsm.network-id": "23003",
        });
    });
    test("auto-config clears apn/user/pass", () => {
        expect(setupToGsmFields({ autoConfig: true })).toEqual({
            "gsm.auto-config": "yes",
            "gsm.apn": "",
            "gsm.username": "",
            "gsm.password": "",
        });
    });
    test("empty setup maps to no fields", () => {
        expect(setupToGsmFields({})).toEqual({});
    });
});

describe("parseModeCombo", () => {
    test("parses a generation-token mode entry", () => {
        expect(parseModeCombo("allowed: 2g, 3g, 4g; preferred: 4g")).toEqual({
            allowed: 0b0111,
            preferred: 0b0100,
        });
    });
    test("parses a D-Bus-name entry without preference", () => {
        expect(parseModeCombo("allowed: gsm, lte; preferred: none")).toEqual({
            allowed: 0b0101,
            preferred: 0,
        });
    });
    test("parses 5G tokens", () => {
        expect(parseModeCombo("allowed: 4g, 5g; preferred: 5g")).toEqual({
            allowed: 0b1100,
            preferred: 0b1000,
        });
        expect(parseModeCombo("allowed: 4g, 5gnr; preferred: 5gnr")).toEqual({
            allowed: 0b1100,
            preferred: 0b1000,
        });
    });
    test("rejects garbage", () => {
        expect(parseModeCombo("")).toBeNull();
        expect(parseModeCombo("preferred: 4g")).toBeNull();
    });
});

describe("setModemModes", () => {
    // A live modem's published list: ascending allowed sets, each with
    // "preferred: none", plus a 4G-preferred entry on the full 2G/3G/4G set.
    const supported234 = [
        { allowed: 0b0001, preferred: 0 }, // 2g
        { allowed: 0b0011, preferred: 0 }, // 2g, 3g
        { allowed: 0b0100, preferred: 0 }, // 4g
        { allowed: 0b0111, preferred: 0 }, // 2g, 3g, 4g
        { allowed: 0b0111, preferred: 0b0100 }, // 2g, 3g, 4g (preferred: 4g)
    ];
    /** A stub whose mmcli succeeds; each test gets its own call log. */
    const ok = () => coreStub(async () => "successfully set current modes in the modem");

    test("sends generation tokens and keeps the preferred the modem admits", async () => {
        const s = ok();
        bindModemManager(s.core);
        const res = await setModemModes(
            2,
            ["gsm", "lte"],
            "lte",
            supported234,
        );
        expect(res).toEqual({
            ok: true,
            allowed: ["gsm", "umts", "lte"],
            preferred: "lte",
            rejected: [],
        });
        const mmcli = s.calls.find((c) => c.includes("--set-allowed-modes"));
        expect(mmcli).toContain("--set-allowed-modes=2g|3g|4g");
        expect(mmcli).toContain("--set-preferred-mode=4g");
    });
    test("widens the allowed set to the smallest supported superset", async () => {
        const s = ok();
        bindModemManager(s.core);
        const res = await setModemModes(
            2,
            ["gsm", "lte"],
            undefined,
            supported234,
        );
        expect(res.allowed).toEqual(["gsm", "umts", "lte"]);
        const mmcli = s.calls.find((c) => c.includes("--set-allowed-modes"));
        expect(mmcli).toContain("--set-allowed-modes=2g|3g|4g");
        expect(mmcli).not.toContain("--set-preferred-mode");
    });
    test("omits the preferred mode when the modem publishes none for the set", async () => {
        const s = ok();
        bindModemManager(s.core);
        const res = await setModemModes(2, ["lte"], "lte", supported234);
        expect(res.preferred).toBeUndefined();
        const mmcli = s.calls.find((c) => c.includes("--set-allowed-modes"));
        expect(mmcli).toContain("--set-allowed-modes=4g");
        expect(mmcli).not.toContain("--set-preferred-mode");
    });
    test("drops a preferred mode the modem cannot prefer", async () => {
        const s = ok();
        bindModemManager(s.core);
        const res = await setModemModes(
            2,
            ["gsm", "umts", "lte"],
            "nr5g",
            supported234,
        );
        expect(res).toEqual({
            ok: true,
            allowed: ["gsm", "umts", "lte"],
            preferred: undefined,
            rejected: [],
        });
        const mmcli = s.calls.find((c) => c.includes("--set-allowed-modes"));
        expect(mmcli).toContain("--set-allowed-modes=2g|3g|4g");
        expect(mmcli).not.toContain("--set-preferred-mode");
    });
    test("rejects a band no supported combination admits, without calling mmcli", async () => {
        const { core, calls } = coreStub(async () => "");
        bindModemManager(core);
        const res = await setModemModes(2, ["nr5g"], "nr5g", supported234);
        expect(res.ok).toBe(false);
        expect(res.rejected).toEqual(["nr5g"]);
        expect(calls.filter((c) => c.includes("--set-allowed-modes"))).toEqual(
            [],
        );
    });
    test("a preferred mode outside the allowed set is ignored", async () => {
        const s = ok();
        bindModemManager(s.core);
        const res = await setModemModes(2, ["gsm"], "lte", supported234);
        expect(res.allowed).toEqual(["gsm"]);
        const mmcli = s.calls.find((c) => c.includes("--set-allowed-modes"));
        expect(mmcli).toContain("--set-allowed-modes=2g");
        expect(mmcli).not.toContain("--set-preferred-mode");
    });
    test("sends the request as-is when the modem reports no supported list", async () => {
        const s = ok();
        bindModemManager(s.core);
        const res = await setModemModes(2, ["gsm", "lte"], "lte");
        expect(res.ok).toBe(true);
        expect(res.allowed).toEqual(["gsm", "lte"]);
        expect(res.preferred).toBe("lte");
        const mmcli = s.calls.find((c) => c.includes("--set-allowed-modes"));
        expect(mmcli).toContain("--set-allowed-modes=2g|4g");
        expect(mmcli).toContain("--set-preferred-mode=4g");
    });
    test("a single allowed RAT is sent without a preferred mode", async () => {
        const { core, calls } = coreStub(async () =>
            "successfully set current modes in the modem",
        );
        bindModemManager(core);
        await setModemModes(2, ["gsm"], "gsm", [
            { allowed: 0b0001, preferred: 0b0001 },
        ]);
        const mmcli = calls.find((c) => c.includes("--set-allowed-modes"));
        expect(mmcli).toContain("--set-allowed-modes=2g");
        expect(mmcli).not.toContain("--set-preferred-mode");
    });
    test("an empty request is a no-op", async () => {
        const { core, calls } = coreStub(async () => "");
        bindModemManager(core);
        const res = await setModemModes(2, [], undefined, supported234);
        expect(res).toEqual({
            ok: true,
            allowed: [],
            preferred: undefined,
            rejected: [],
        });
        expect(calls).toEqual([]);
    });
    test("a missing success marker is a failure", async () => {
        const coreStub2 = coreStub(async () => "something unexpected");
        bindModemManager(coreStub2.core);
        const res = await setModemModes(2, ["gsm", "lte"], "lte", supported234);
        expect(res.ok).toBe(false);
        expect(res.rejected).toEqual(["gsm", "lte"]);
    });
});

describe("pruneOrphanGsmConns", () => {
    test("deletes only gsm conns bound to neither a device nor a SIM", async () => {
        const { core, calls } = coreStub(async (cmd, args) => {
            if (cmd === "nmcli" && args.includes("--get-values")) {
                // Last arg is the conn uuid being inspected.
                const uuid = args[args.length - 1];
                // bound1 carries a device-id + sim-id; orphan1 does not.
                return uuid === "bound1"
                    ? "/sys/bus/usb/devices/3-1\n89881234567890\n23003\ninternet"
                    : "\n\n\ninternet";
            }
            if (cmd === "nmcli" && args.includes("show"))
                return "orphan1:gsm:activated\nbound1:gsm:activated";
            if (cmd === "nmcli" && args[1] === "del")
                return "Connection 'orphan1' (orphan1) successfully deleted.";
            return "";
        });
        bindModemManager(core);
        const removed = await pruneOrphanGsmConns();
        expect(removed).toBe(1);
        expect(calls.join(" ")).toContain("conn del orphan1");
        expect(calls.join(" ")).not.toContain(" conn del bound1");
    });
});
