import { Elysia } from "elysia";
import { upgradeRequired } from "../../http";
import type { createDevices } from "../devices";
import { socketMessage } from "../../socket-message";
import { socketAdapter } from "../socket";

type Devices = ReturnType<typeof createDevices>;

export function deviceConnectionRoutes(devices: Devices) {
    return new Elysia({ name: "control-device-connection" })
        .derive(({ request, server }) => ({
            connection: devices.deviceConnection(
                request,
                new URL(request.url),
                server?.requestIP(request)?.address ?? "",
            ),
        }))
        .onBeforeHandle(({ connection }) =>
            connection instanceof Response ? connection : undefined,
        )
        .get("/device", () => upgradeRequired())
        .ws("/device", {
            open(ws) {
                const connection = ws.data.connection;
                if (
                    connection instanceof Response ||
                    connection.kind !== "device"
                )
                    return ws.close(1011, "Missing device connection data");
                devices.open(socketAdapter(ws, connection));
            },
            message(ws, message) {
                const connection = ws.data.connection;
                if (
                    connection instanceof Response ||
                    connection.kind !== "device"
                )
                    return;
                devices.message(
                    socketAdapter(ws, connection),
                    socketMessage(message),
                );
            },
            close(ws, code, reason) {
                const connection = ws.data.connection;
                if (
                    connection instanceof Response ||
                    connection.kind !== "device"
                )
                    return;
                devices.close(socketAdapter(ws, connection), code, reason);
            },
        });
}
