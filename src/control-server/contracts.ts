import type { ServerWebSocket } from "bun";
import type { Role } from "../validate";

export const LOCAL_USER = "local";
export const ID_RE = /^[\w.-]{1,64}$/;

export type WsData =
    | {
          kind: "device";
          id: string;
          address: string;
          owner: string;
          role?: Role;
      }
    | { kind: "viewer"; id: string; user: string }
    | { kind: "dashboards"; user: string };

export type Socket = ServerWebSocket<WsData>;
export type Publish = (topic: string, message: string) => void;

export const viewersTopic = (id: string) => `viewers:${id}`;
export const dashboardsTopic = (user: string) => `dashboards:${user}`;
export const devicesTopic = (user: string) => `devices:${user}`;
export const WIDGET_HUB_TOPIC = "widgets:hub";

export const event = (name: string, data: unknown) =>
    JSON.stringify({ type: "event", event: name, data });
