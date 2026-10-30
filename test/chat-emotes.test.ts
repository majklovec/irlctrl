import { beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import type m from "mithril";

let chat: typeof import("../modules/chat/frontend");

beforeAll(async () => {
    const result = await Bun.build({
        entrypoints: [new URL("../modules/chat/frontend.tsx", import.meta.url).pathname],
        target: "browser",
        format: "cjs",
        external: ["mithril"],
        loader: { ".css": "text" },
        plugins: [{
            name: "chat-browser-shell",
            setup(build) {
                build.onLoad({ filter: /frontend\/ts\/(?:i18n|components\/ui)\.tsx$/ }, () => ({
                    contents: "export const currentLanguage = () => 'en'; export const t = (key) => key; export const Badge = {};",
                    loader: "js",
                }));
            },
        }],
    });
    if (!result.success) throw new AggregateError(result.logs, "Chat test bundle failed");
    const module = { exports: {} };
    runInNewContext(await result.outputs[0].text(), {
        module,
        exports: module.exports,
        require: createRequire(import.meta.url),
        window: { addEventListener() {} },
    });
    chat = module.exports as typeof chat;
});

function emoteImages(text: string): m.Vnode[] {
    chat.default.onFrame?.("widget.snapshot", {
        chat: { "kick:example": { connected: true, messages: [{ id: text, text }] } },
    });
    const feed = chat.chatFeed({ id: "emote-test", config: { kick: "example" } });
    if (!feed || typeof feed !== "object" || Array.isArray(feed) || !("tag" in feed)) {
        throw new Error("Missing chat feed");
    }
    const component = feed.tag;
    if (typeof component !== "object" || !("view" in component)) {
        throw new Error("Missing chat feed component");
    }
    const images: m.Vnode[] = [];
    function visit(node: m.Children): void {
        if (Array.isArray(node)) {
            node.forEach(visit);
        } else if (node && typeof node === "object" && "tag" in node) {
            if (node.tag === "img" && node.attrs.className === "chat-emote") images.push(node);
            visit(node.children);
        }
    }
    visit(component.view(feed));
    return images;
}

describe("Kick emotes in the shared dashboard and overlay feed", () => {
    test("renders adjacent collectible emotes with valid Kick image URLs", () => {
        const images = emoteImages("[emote:5748013:collectiblesRAGEY][emote:5748062:collectiblesErm]");
        expect(images.map((image) => image.attrs.src)).toEqual([
            "https://files.kick.com/emotes/5748013/fullsize",
            "https://files.kick.com/emotes/5748062/fullsize",
        ]);
        expect(images.map((image) => image.attrs.alt)).toEqual([
            "collectiblesRAGEY",
            "collectiblesErm",
        ]);
    });

    test("renders global and channel emotes mixed with text", () => {
        expect(emoteImages("Hello [emote:37226:KEKW] [emote:6213260:mikesesWW]!")
            .map((image) => image.attrs.src)).toEqual([
                "https://files.kick.com/emotes/37226/fullsize",
                "https://files.kick.com/emotes/6213260/fullsize",
            ]);
    });

    test("keeps direct emote CDN URLs working", () => {
        expect(emoteImages("https://cdn.7tv.app/emote/example/1x.webp")
            .map((image) => image.attrs.src)).toEqual([
                "https://cdn.7tv.app/emote/example/4x.webp",
            ]);
        expect(emoteImages("Plain text :unknown:")).toEqual([]);
    });
});
