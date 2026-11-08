import type { Role } from "../../shared/validate";

export const LOCAL_USER = "local";
/**
 * The `--no-auth` synthetic project id. No user rows exist in that mode, so
 * the Personal-project scheme (`personal-<user id>`, migration 0012) has no
 * user id to build from; every local connection scopes to this id instead.
 */
export const LOCAL_PROJECT_ID = "personal-local";
export const ID_RE = /^[\w.-]{1,64}$/;

export type WsData =
    | {
          kind: "device";
          id: string;
          address: string;
          project: string;
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
// keyed per overlay id (not per user) so one owner's overlays can't feed
// each other's OBS runtime pages
export const overlayRuntimeTopic = (overlayId: string) =>
    `overlay-runtime:${overlayId}`;
export const WIDGET_HUB_TOPIC = "widgets:hub";

export const event = (name: string, data: unknown) =>
    JSON.stringify({ type: "event", event: name, data });
