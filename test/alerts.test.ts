import { describe, expect, test } from "bun:test";

// The element module imports the browser i18n module, which touches
// document/window at import time — stub minimal globals before the dynamic
// import so it loads headlessly (same convention as overlay_elements.test.ts).
(globalThis as Record<string, unknown>).document = { documentElement: {} };
(globalThis as Record<string, unknown>).window = {
    location: { origin: "http://localhost" },
};

const alerts = await import(
    "../server/pages/overlays/modules/overlay_elements/elements/alerts"
);
const { DEFAULT_ALERT_PROPS } = await import(
    "../server/pages/overlays/modules/overlay_elements/overlay_schema"
);
const { triggerPhase } = await import("../shared/ui/overlay/element");

import type { VariableValue } from "../shared/overlay";
import type {
    ElementContext,
    OverlayElement,
} from "../shared/ui/overlay/element";

const el = (over: Record<string, unknown> = {}): OverlayElement => ({
    id: "a1",
    name: "alert",
    type: "alert",
    transform: { x: 0, y: 0, width: 420, height: 160, rotation: 0, opacity: 1 },
    visible: true,
    locked: false,
    parentId: null,
    bindings: {},
    props: { ...DEFAULT_ALERT_PROPS, ...over },
});

const ctx = (over: Partial<ElementContext> = {}): ElementContext => ({
    assetUrls: new Map<string, string>(),
    variables: new Map<string, VariableValue>(),
    variableNames: new Map<string, VariableValue>(),
    ...over,
});

describe("parseTemplate", () => {
    test("splits plain and token runs, merging adjacent same-kind", () => {
        expect(alerts.parseTemplate("Hello {name}!")).toEqual([
            { text: "Hello ", token: false },
            { text: "name", token: true },
            { text: "!", token: false },
        ]);
        // adjacent tokens merge into one token segment
        expect(alerts.parseTemplate("{a}{b}")).toEqual([
            { text: "ab", token: true },
        ]);
        expect(alerts.parseTemplate("plain")).toEqual([
            { text: "plain", token: false },
        ]);
        expect(alerts.parseTemplate("")).toEqual([]);
        // an empty token `{}` drops out
        expect(alerts.parseTemplate("a{}b")).toEqual([
            { text: "ab", token: false },
        ]);
    });
});

describe("tokenValue / templateText", () => {
    test("variable name wins over the payload key", () => {
        const c = ctx({
            variableNames: new Map([["name", "var-name"]]),
        });
        expect(alerts.tokenValue("name", c, { name: "payload-name" })).toBe(
            "var-name",
        );
    });

    test("falls back to the payload; objects serialize; missing is empty", () => {
        const c = ctx();
        expect(alerts.tokenValue("name", c, { name: "payload-name" })).toBe(
            "payload-name",
        );
        expect(alerts.tokenValue("n", c, { n: 12 })).toBe("12");
        expect(alerts.tokenValue("o", c, { o: { a: 1 } })).toBe('{"a":1}');
        expect(alerts.tokenValue("missing", c, {})).toBe("");
        expect(alerts.tokenValue("null", c, { null: null })).toBe("");
    });

    test("templateText resolves to plain text for TTS", () => {
        const c = ctx({ variableNames: new Map([["name", "Ada"]]) });
        expect(
            alerts.templateText("Hi {name}, {amount} came in", c, {
                amount: 50,
            }),
        ).toBe("Hi Ada, 50 came in");
    });
});

describe("alert validate()", () => {
    test("well-formed defaults are clean", () => {
        expect(alerts.alertsElement.validate(el())).toEqual([]);
    });

    test("reports missing event and bad numbers", () => {
        expect(alerts.alertsElement.validate(el({ event: "" }))).toEqual([
            "alert has no event",
        ]);
        expect(alerts.alertsElement.validate(el({ duration: 100000 }))).toEqual(
            ["alert duration out of range (500–60000 ms)"],
        );
        expect(alerts.alertsElement.validate(el({ videoVolume: 2 }))).toEqual([
            "video volume must be in 0–1",
        ]);
        expect(
            alerts.alertsElement.validate(el({ audioVolume: -0.5 })),
        ).toEqual(["audio volume must be in 0–1"]);
        expect(
            alerts.alertsElement.validate(el({ conditionValue: -1 })),
        ).toEqual(["condition value must be >= 0"]);
        expect(alerts.alertsElement.validate(el({ ttsMinAmount: -1 }))).toEqual(
            ["TTS minimum amount must be >= 0"],
        );
    });
});

describe("alert draw()", () => {
    test("design state: layout class, no animation, no media without an asset", () => {
        const json = JSON.stringify(alerts.alertsElement.draw!(el(), ctx()));
        expect(json).toContain("overlay-alert");
        expect(json).toContain("overlay-alert-stack");
        expect(json).not.toContain("alert-intro-");
        expect(json).not.toContain("alert-outro-");
        expect(json).not.toContain("overlay-alert-media");
        // the template renders the static parts
        expect(json).toContain("Hello");
    });

    test("layout and text animation classes", () => {
        const row = JSON.stringify(
            alerts.alertsElement.draw!(
                el({ layoutType: "row", textAnimation: "typewriter" }),
                ctx(),
            ),
        );
        expect(row).toContain("overlay-alert-row");
        expect(row).toContain("alert-text-typewriter");
        const overlay = JSON.stringify(
            alerts.alertsElement.draw!(el({ layoutType: "overlay" }), ctx()),
        );
        expect(overlay).toContain("overlay-alert-overlay");
        // `none` text animation adds no class
        expect(
            JSON.stringify(alerts.alertsElement.draw!(el(), ctx())),
        ).not.toContain("alert-text-");
    });

    test("image and video media render from the asset URL", () => {
        const urls = new Map([["m1", "data:image/png;base64,xx"]]);
        const img = JSON.stringify(
            alerts.alertsElement.draw!(
                el({ mediaAssetId: "m1" }),
                ctx({ assetUrls: urls }),
            ),
        );
        expect(img).toContain("img");
        expect(img).toContain("data:image/png;base64,xx");
        const vid = JSON.stringify(
            alerts.alertsElement.draw!(
                el({ assetType: "video", mediaAssetId: "m1" }),
                ctx({ assetUrls: urls }),
            ),
        );
        expect(vid).toContain('"tag":"video"');
        expect(vid).toContain("overlay-alert-media");
        // a missing asset URL renders no media node
        expect(
            JSON.stringify(
                alerts.alertsElement.draw!(el({ mediaAssetId: "gone" }), ctx()),
            ),
        ).not.toContain("overlay-alert-media");
    });

    test("token segments carry the accent colour and resolved value", () => {
        const c = ctx({
            variableNames: new Map([["name", "Ada"]]),
            activeTriggers: new Map([
                [
                    "a1",
                    {
                        startedAt: Date.now() - 1000,
                        expiresAt: Date.now() + 4000,
                        payload: { message: "thanks for 25" },
                    },
                ],
            ]),
        });
        const json = JSON.stringify(
            alerts.alertsElement.draw!(
                el({
                    titleTemplate: "Hi {name}",
                    messageTemplate: "{message}",
                }),
                c,
            ),
        );
        expect(json).toContain("Ada");
        expect(json).toContain("thanks for 25");
        expect(json).toContain("#ffd700");
    });

    test("trigger phases apply the intro/outro animation classes", () => {
        const now = Date.now();
        const active = (startedAt: number, expiresAt: number): ElementContext =>
            ctx({
                activeTriggers: new Map([
                    ["a1", { startedAt, expiresAt, payload: {} }],
                ]),
            });
        const draw = (c: ElementContext): string =>
            JSON.stringify(alerts.alertsElement.draw!(el(), c));

        expect(draw(active(now, now + 5000))).toContain(
            "alert-intro-slideDown",
        );
        expect(draw(active(now - 1000, now + 4000))).not.toContain(
            "alert-intro-",
        );
        expect(draw(active(now - 4500, now + 200))).toContain(
            "alert-outro-fadeOut",
        );
        // `none` animations never apply a class, even mid-phase
        const none = el({ introAnimation: "none", outroAnimation: "none" });
        expect(
            JSON.stringify(
                alerts.alertsElement.draw!(none, active(now, now + 5000)),
            ),
        ).not.toContain("alert-intro-");
    });
});

describe("triggerPhase()", () => {
    const now = 1_000_000;
    test("walks the phase machine", () => {
        const active = (startedAt: number, expiresAt: number) => ({
            startedAt,
            expiresAt,
            payload: {},
        });
        expect(triggerPhase(undefined, now)).toBe("design");
        expect(triggerPhase(active(now, now + 5000), now)).toBe("in");
        expect(triggerPhase(active(now - 500, now + 4000), now)).toBe("show");
        expect(triggerPhase(active(now - 4600, now + 390), now)).toBe("out");
        expect(triggerPhase(active(now - 9000, now - 10), now)).toBe("design");
    });
});

describe("alert onTrigger()", () => {
    const onTrigger = alerts.alertsElement.onTrigger!;

    test("claims the trigger only for its own event", () => {
        expect(onTrigger(el(), "twitch.follow", {}, ctx())).toBe(
            DEFAULT_ALERT_PROPS.duration,
        );
        expect(onTrigger(el(), "twitch.cheer", {}, ctx())).toBeUndefined();
    });

    test("variation alerts need an amount that satisfies the condition", () => {
        const variation = el({
            isVariation: true,
            conditionType: "min",
            conditionValue: 10,
        });
        expect(
            onTrigger(variation, "twitch.follow", { amount: 9 }, ctx()),
        ).toBeUndefined();
        expect(
            onTrigger(variation, "twitch.follow", { amount: 10 }, ctx()),
        ).toBe(DEFAULT_ALERT_PROPS.duration);
        expect(
            onTrigger(variation, "twitch.follow", {}, ctx()),
        ).toBeUndefined();

        const exact = el({
            isVariation: true,
            conditionType: "exact",
            conditionValue: 10,
        });
        expect(onTrigger(exact, "twitch.follow", { amount: 10 }, ctx())).toBe(
            DEFAULT_ALERT_PROPS.duration,
        );
        expect(
            onTrigger(exact, "twitch.follow", { amount: 11 }, ctx()),
        ).toBeUndefined();
        // a variable named `amount` wins over the payload key
        expect(
            onTrigger(
                exact,
                "twitch.follow",
                { amount: 11 },
                ctx({ variableNames: new Map([["amount", "10"]]) }),
            ),
        ).toBe(DEFAULT_ALERT_PROPS.duration);
    });

    test("honours the configured duration", () => {
        expect(
            onTrigger(el({ duration: 2500 }), "twitch.follow", {}, ctx()),
        ).toBe(2500);
    });
});
