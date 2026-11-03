import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { APP_VERSION } from "../../../shared/app_version";
import type { ControlRouteContext } from "../../../shared/contracts/backend_module";
import type { ServerDashboardWidget } from "../../../shared/contracts/wire";
import { upgradeRequired } from "../../../shared/http";
import { chatSpecsFromConfig } from "./config";
import type { ChatOverlayState, ChatSnapshot } from "./types";

const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
};

/** The WebSocket route path — parsed from the upgrade request URL in `open`. */
const WS_PATH_RE = /^\/api\/chat\/([^/]+)\/([^/]+)\/ws$/;

function tokenMatches(
    expected: string | undefined,
    presented: string,
): boolean {
    if (!expected || !presented) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function chatOverlayRoutes(context: ControlRouteContext) {
    function authorizedWidget(
        dashboardId: string,
        widgetId: string,
        request: Request,
    ): ServerDashboardWidget | undefined {
        const widget = context
            .dashboardById(dashboardId)
            ?.widgets.find((w) => w.id === widgetId && w.type === "chat");
        const authorization = request.headers.get("authorization");
        const token =
            authorization === null
                ? new URL(request.url).searchParams.get("token") ?? ""
                : authorization.startsWith("Bearer ")
                  ? authorization.slice(7)
                  : "";
        return tokenMatches(widget?.config?.token, token) ? widget : undefined;
    }

    const denied = () =>
        new Response("Invalid chat token", { status: 401, headers });

    /**
     * The widget's overlay state: its config (sans token) plus the rolling
     * chat, narrowed to the channels the widget displays. Shared by the
     * polling endpoint and the WebSocket snapshot frame.
     */
    function overlayState(widget: ServerDashboardWidget): ChatOverlayState {
        const { token, ...config } = widget.config ?? {};
        const all = context.widgetHubSnapshot().chat as ChatSnapshot;
        const chat: ChatSnapshot = {};
        for (const spec of chatSpecsFromConfig(config)) {
            if (spec && all[spec]) chat[spec] = all[spec];
        }
        return {
            widget: { id: widget.id, config },
            chat,
            version: APP_VERSION,
        };
    }

    return new Elysia({ name: "chat-overlay" })
        .get("/chat/:dashboardId/:widgetId", ({ params, request }) => {
            if (!authorizedWidget(params.dashboardId, params.widgetId, request))
                return denied();
            const response = context.htmlResponse("chatoverlay");
            for (const [key, value] of Object.entries(headers))
                response.headers.set(key, value);
            return response;
        })
        .get("/api/chat/:dashboardId/:widgetId", ({ params, request }) => {
            const widget = authorizedWidget(
                params.dashboardId,
                params.widgetId,
                request,
            );
            if (!widget) return denied();
            return Response.json(overlayState(widget), { headers });
        })
        .get("/api/chat/:dashboardId/:widgetId/ws", ({ params, request }) => {
            if (!authorizedWidget(params.dashboardId, params.widgetId, request))
                return denied();
            return upgradeRequired();
        })
        .ws("/api/chat/:dashboardId/:widgetId/ws", {
            open(ws) {
                const m = WS_PATH_RE.exec(
                    new URL(ws.data.request.url).pathname,
                );
                if (!m) return ws.close(1008, "Unknown chat route");
                const widget = authorizedWidget(
                    decodeURIComponent(m[1]),
                    decodeURIComponent(m[2]),
                    ws.data.request,
                );
                if (!widget) return ws.close(1008, "Invalid chat token");
                // Snapshot first, then the hub's live frames (topic messages
                // reach this socket from the next tick on). The stream carries
                // every channel, just like the dashboard websocket — the
                // overlay client renders only this widget's configured specs.
                ws.subscribe(context.widgetHubTopic());
                ws.send(
                    JSON.stringify({
                        type: "event",
                        event: "chat.overlay.snapshot",
                        data: overlayState(widget),
                    }),
                );
            },
        });
}
