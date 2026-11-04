import { Elysia } from "elysia";
import { APP_VERSION } from "../../../../../shared/app_version";
import type { ControlRouteContext } from "../../../../../shared/contracts/backend_module";
import { upgradeRequired } from "../../../../../shared/http";
import type { ChatSnapshot } from "./types";

const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
};

export function chatOverlayRoutes(context: ControlRouteContext) {
    const denied = () =>
        new Response("Invalid chat token", { status: 401, headers });

    /** The overlay's chat channel specs, `null` when the token is unknown. */
    function overlaySpecs(overlayId: string, request: Request): string[] | null {
        return context.overlayChatOverlaySpecs(
            new URL(request.url).searchParams.get("token") ?? "",
            overlayId,
        );
    }

    /** The hub's rolling chat, narrowed to the given channel specs. */
    function overlayChatSnapshot(specs: string[]): ChatSnapshot {
        const all = context.widgetHubSnapshot().chat as ChatSnapshot;
        const chat: ChatSnapshot = {};
        for (const spec of specs) if (all[spec]) chat[spec] = all[spec];
        return chat;
    }

    /** The overlay id from a URL's path: the last non-empty segment, minus a
     * trailing `/ws` (the WebSocket route sits under the overlay path). */
    const overlayIdFrom = (url: URL): string => {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[parts.length - 1] === "ws") parts.pop();
        return decodeURIComponent(parts.pop() ?? "");
    };

    // The chat overlay element is self-contained: it carries its own channel
    // list and authenticates with the OBS overlay's token (no dashboard chat
    // widget). The endpoint resolves the overlay's chat channels, keeps their
    // providers attached for the connection, and streams the hub frames
    // narrowed to those channels.
    return new Elysia({ name: "chat-overlay" }).get(
        "/api/overlay/chat/:id",
        ({ request }) => {
            const specs = overlaySpecs(
                overlayIdFrom(new URL(request.url)),
                request,
            );
            if (specs === null) return denied();
            return Response.json(
                { chat: overlayChatSnapshot(specs), version: APP_VERSION },
                { headers },
            );
        })
        .get("/api/overlay/chat/:id/ws", ({ request }) => {
            if (
                overlaySpecs(overlayIdFrom(new URL(request.url)), request) ===
                null
            )
                return denied();
            return upgradeRequired();
        })
        .ws("/api/overlay/chat/:id/ws", {
            open(ws) {
                const url = new URL(ws.data.request.url);
                const specs = overlaySpecs(overlayIdFrom(url), ws.data.request);
                if (specs === null) return ws.close(1008, "Invalid chat token");
                // Keep the overlay's providers attached for exactly this
                // viewer; the `close` handler releases them. `ws.data` (the
                // upgrade request) is the one per-connection object that
                // persists across the open/close handlers, so the specs ride
                // on it.
                context.acquireChatChannels(specs);
                (ws.data as { overlaySpecs?: string[] }).overlaySpecs = specs;
                // Snapshot first (narrowed to the overlay's channels, which are
                // already up in the hub), then the hub's live frames.
                ws.subscribe(context.widgetHubTopic());
                ws.send(
                    JSON.stringify({
                        type: "event",
                        event: "chat.overlay.snapshot",
                        data: {
                            chat: overlayChatSnapshot(specs),
                            version: APP_VERSION,
                        },
                    }),
                );
            },
            close(ws) {
                const specs = (ws.data as { overlaySpecs?: string[] })
                    .overlaySpecs;
                if (specs) context.releaseChatChannels(specs);
            },
        });
}
