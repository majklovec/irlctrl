import { Elysia } from "elysia";
import { originAllowed, text, upgradeRequired } from "../../../shared/http";
import { socketMessage } from "../../../shared/socket-message";
import { errorMessage } from "../../../shared/util";
import { ALLOWED_ORIGINS } from "../config";
import { handleRequest } from "../methods";
import { logHistoryEvent, retainedEvents, statusEvent } from "../push";

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
                    for (const msg of retainedEvents()) ws.send(msg);
                } catch (err: unknown) {
                    console.error("Initial status failed:", errorMessage(err));
                }
            },
            async message(ws, raw) {
                ws.send(await handleRequest(socketMessage(raw)));
            },
        });
}
