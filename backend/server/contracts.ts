import type { Role } from "../../shared/validate";

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

export interface Socket {
    data: WsData;
    readonly readyState: number;
    send(message: string): number;
    close(code?: number, reason?: string): void;
    subscribe(topic: string): void;
}
export type Publish = (topic: string, message: string) => void;

export const viewersTopic = (id: string) => `viewers:${id}`;
export const dashboardsTopic = (user: string) => `dashboards:${user}`;
export const devicesTopic = (user: string) => `devices:${user}`;
export const WIDGET_HUB_TOPIC = "widgets:hub";

export const event = (name: string, data: unknown) =>
    JSON.stringify({ type: "event", event: name, data });
