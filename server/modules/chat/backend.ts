/*
 * chat backend — the server-side chat hub, one instance for every `chat`
 * widget. Each widget config lists a channel per platform (`youtube`,
 * `twitch`, `tiktok`, `kick`); every filled channel becomes a spec
 * `<platform>:<channel>` the hub keeps attached through a platform provider
 * (providers/{youtube,twitch,tiktok,kick}.ts) that owns the transport and
 * pushes the platform's `*.chat` events to the dashboard websocket topic.
 *
 * All channels are device-independent and public (no auth), so the hub serves
 * all chat widgets: two widgets with the same platform channel share one
 * provider. The providers keep a rolling message history so reconnections
 * don't re-send, and a `seen` set that dedupes message ids across
 * reconnections (in providers/base.ts).
 *
 * The widget's `history` config caps how many merged lines the frontend shows
 * and `order` places new messages at the top (newest first, the default) or
 * the bottom (oldest first, like a normal log).
 */

import {
    CHAT_CONFIG_FIELDS,
    CHAT_PLATFORMS,
    chatSpecsFromConfig,
} from "./config";
import { ChatProvider } from "./providers/base";
import { chatOverlayRoutes } from "./overlay_server";
import { KickChatProvider } from "./providers/kick";
import { TiktokChatProvider } from "./providers/tiktok";
import { TwitchChatProvider } from "./providers/twitch";
import { YoutubeChatProvider } from "./providers/youtube";
import type { ChannelSpecs, ChatSnapshot, PublishFn } from "./types";
export type { ChatSnapshot } from "./types";

/** Split a spec into its platform and channel halves (null on a bad spec). */
function parseSpec(spec: string): { platform: string; channel: string } | null {
    const at = spec.indexOf(":");
    if (at <= 0 || at === spec.length - 1) return null;
    const platform = spec.slice(0, at);
    if (!(CHAT_PLATFORMS as readonly string[]).includes(platform)) return null;
    return {
        platform,
        channel: spec
            .slice(at + 1)
            .trim()
            .toLowerCase(),
    };
}

/** Build one provider for a spec key (`<platform>:<channel>`). */
function providerFor(spec: string, publish: PublishFn): ChatProvider | null {
    const parts = parseSpec(spec);
    if (!parts) return null;
    switch (parts.platform) {
        case "youtube":
            return new YoutubeChatProvider(parts.channel, publish);
        case "twitch":
            return new TwitchChatProvider(parts.channel, publish);
        case "tiktok":
            return new TiktokChatProvider(parts.channel, publish);
        case "kick":
            return new KickChatProvider(parts.channel, publish);
        default:
            return null;
    }
}

/**
 * State manager for chat channels across all platforms. A provider stays
 * attached while it is needed by either source: the dashboard widgets'
 * `sync(specs)` (the `#synced` set) or a refcounted `acquire(specs)` (the
 * `#refs` map — the standalone overlay chat elements start it for as long as a
 * viewer is connected). `reconcile()` starts what is needed and stops the rest.
 */
export class ChatChannelManager {
    #providers = new Map<string, ChatProvider>();
    #publish: PublishFn;
    /** Specs kept attached by the dashboard widgets (last `sync`). */
    #synced = new Set<string>();
    /** Per-spec viewer reference counts (standalone overlay chat). */
    #refs = new Map<string, number>();

    constructor(publish: PublishFn) {
        this.#publish = publish;
    }

    start(spec: string): void {
        if (this.#providers.has(spec)) return;
        const provider = providerFor(spec, this.#publish);
        if (!provider) {
            console.warn(`[chat] bad spec ${spec}`);
            return;
        }
        this.#providers.set(spec, provider);
        provider.start();
    }

    stop(spec: string): void {
        const provider = this.#providers.get(spec);
        if (!provider) return;
        this.#providers.delete(spec);
        provider.stop();
    }

    /** The union of specs still needed by dashboard widgets or a viewer. */
    #needed(): Set<string> {
        const out = new Set(this.#synced);
        for (const [spec, n] of this.#refs) if (n > 0) out.add(spec);
        return out;
    }

    /** Start the needed specs and stop the ones no longer needed. */
    #reconcile(): void {
        const needed = this.#needed();
        for (const spec of needed) this.start(spec);
        for (const spec of [...this.#providers.keys()])
            if (!needed.has(spec)) this.stop(spec);
    }

    sync(specs: ChannelSpecs): void {
        this.#synced = new Set(
            [...specs].filter((spec): spec is string => spec !== null && spec !== ""),
        );
        this.#reconcile();
    }

    /** A viewer (standalone overlay chat) started needing these specs. */
    acquire(specs: string[]): void {
        for (const spec of new Set(specs))
            this.#refs.set(spec, (this.#refs.get(spec) ?? 0) + 1);
        this.#reconcile();
    }

    /** A viewer stopped needing these specs. */
    release(specs: string[]): void {
        for (const spec of new Set(specs)) {
            const n = (this.#refs.get(spec) ?? 0) - 1;
            if (n <= 0) this.#refs.delete(spec);
            else this.#refs.set(spec, n);
        }
        this.#reconcile();
    }

    startedChannels(): string[] {
        return [...this.#providers.keys()];
    }

    /** Rolling history (newest first) per channel plus transport state. */
    snapshot(): ChatSnapshot {
        const out: ChatSnapshot = {};
        for (const [spec, provider] of this.#providers)
            out[spec] = provider.snapshot();
        return out;
    }

    destroy(): void {
        this.#synced = new Set();
        this.#refs = new Map();
        for (const spec of this.startedChannels()) this.stop(spec);
    }
}

/** Widget registration (the backend registry's hub wiring); the core reaches
 * this module only through it, no per-module imports in the core. */
export default {
    id: "chat",
    kind: "widget" as const,
    title: "Chat",
    controlRoutes: chatOverlayRoutes,
    hub: {
        widgetType: "chat",
        snapshotKey: "chat",
        defaultSize: { w: 3, h: 8 },
        configFields: CHAT_CONFIG_FIELDS,
        channelSpec: chatSpecsFromConfig,
        create: (publish: PublishFn): ChatChannelManager =>
            new ChatChannelManager(publish),
    },
};
