import { Elysia } from "elysia";
import { ALLOWED_ORIGINS } from "../config";
import { originAllowed, text, upgradeRequired } from "../http";
import { handleRequest } from "../methods";
import {
    logHistoryEvent,
    statsEvent,
    statusEvent,
} from "../push";
import { latestSrtlaStats } from "../srtlaControl";
import { socketMessage } from "../socket-message";
import { errorMessage } from "../util";

export function deviceRpcPlugin() {
    return new Elysia({ name: "device-api-rpc" })
        .all("/ws", ({ request }) =>
            originAllowed(request, ALLOWED_ORIGINS)
                ? upgradeRequired()
                : text("Origin not allowed", 403),
        )
        .ws("/ws", {
            beforeHandle({ request }) {
                if (!originAllowed(request, ALLOWED_ORIGINS))
                    return text("Origin not allowed", 403);
            },
            async open(ws) {
                ws.subscribe("status");
                try {
                    ws.send(logHistoryEvent());
                    ws.send(await statusEvent());
                    if (latestSrtlaStats().stats) ws.send(statsEvent());
                } catch (err: unknown) {
                    console.error(
                        "Initial status failed:",
                        errorMessage(err),
                    );
                }
            },
            async message(ws, raw) {
                ws.send(await handleRequest(socketMessage(raw)));
            },
        });
}
