import type { Socket, WsData } from "./contracts";

interface ElysiaSocket {
    raw: {
        readyState: number;
        send(message: string): number;
        close(code?: number, reason?: string): void;
        subscribe(topic: string): void;
    };
}

const sockets = new WeakMap<object, Socket>();

/** Keep one stable adapter per raw Bun socket across Elysia callbacks. */
export function socketAdapter(ws: ElysiaSocket, data: WsData): Socket {
    const existing = sockets.get(ws.raw);
    if (existing) return existing;

    const socket: Socket = {
        data,
        get readyState() {
            return ws.raw.readyState;
        },
        send: (message) => ws.raw.send(message),
        close: (code, reason) => ws.raw.close(code, reason),
        subscribe: (topic) => ws.raw.subscribe(topic),
    };
    sockets.set(ws.raw, socket);
    return socket;
}
