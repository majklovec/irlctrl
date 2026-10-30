import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import type { ControlRouteContext } from "../../shared/module-contract";
import type { ServerDashboardWidget } from "../../shared/types";
import { chatSpecsFromConfig } from "./config";
import type { ChatOverlayState, ChatSnapshot } from "./types";

const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
};

function tokenMatches(expected: string | undefined, presented: string): boolean {
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
        const widget = context.dashboardById(dashboardId)?.widgets.find(
            (w) => w.id === widgetId && w.type === "chat",
        );
        const authorization = request.headers.get("authorization");
        const token = authorization === null
            ? new URL(request.url).searchParams.get("token") ?? ""
            : authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        return tokenMatches(widget?.config?.token, token) ? widget : undefined;
    }

    const denied = () => new Response("Invalid chat token", { status: 401, headers });

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
            const widget = authorizedWidget(params.dashboardId, params.widgetId, request);
            if (!widget) return denied();
            const { token, ...config } = widget.config ?? {};
            const all = context.widgetHubSnapshot().chat as ChatSnapshot;
            const chat: ChatSnapshot = {};
            for (const spec of chatSpecsFromConfig(config)) {
                if (spec && all[spec]) chat[spec] = all[spec];
            }
            const state: ChatOverlayState = {
                widget: { id: widget.id, config },
                chat,
            };
            return Response.json(state, { headers });
        });
}
