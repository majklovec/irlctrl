/*
 * The device page's server half: the device registry (moved from
 * the devices slice registry (01-refactor: this file was server/backend/devices/device_registry.ts)) plus its four route groups —
 * the list page (`/`, `/devices/`, `/api/devices`), the device connection
 * WS (`/device`), the device pages (`/d/*`) and the viewer WS
 * (`/d/:id/ws`). The groups stay separate Elysia plugins (their derive /
 * onBeforeHandle hooks are per-plugin) and are composed onto the page's
 * plugin by index.ts during init, which is also where the registry is built
 * and published as the "devices" capability (consumed by the other pages
 * and the module control routes).
 */
import { Elysia } from "elysia";
import {
    notFound,
    originAllowed,
    text,
    upgradeRequired,
} from "../../../../shared/http";
import { socketMessage } from "../../../../shared/socket_message";
import { modulePage } from "../../../../shared/registry";
import type { PageServices } from "../../../core/contracts";
import { ID_RE, LOCAL_USER, type WsData } from "../../../core/runtime";
import { socketAdapter } from "../../../core/socket";
import {
    authenticatedHandler,
    unauthenticatedResponse,
} from "../../../core/auth/authenticated";
import type { createDevices } from "./registry";

type Devices = ReturnType<typeof createDevices>;

/* The device list: its page (`/devices/`, also the home page `/`) and the
 * summaries API it reads. */
function deviceListRoutes(
	s: PageServices,
	devices: Devices,
) {
	const { auth, frontend } = s;
	const page = authenticatedHandler(auth, () =>
		frontend.htmlResponse("device_list"),
	);
	return new Elysia({ name: "control-device-list" })
		.get("/", page)
		.get("/devices/", page)
		.get(
			"/api/devices",
			authenticatedHandler(auth, (_request, user) =>
				Response.json(devices.summaries(user)),
			),
		);
}

function deviceConnectionRoutes(devices: Devices) {
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

function devicePageRoutes(s: PageServices, devices: Devices) {
    const { auth, frontend } = s;
    const DEVICE_PATH_RE = /^\/d\/([^/]+)(?:(\/)(?:(ws)|(settings|setup)(\/)?)?)?$/;
    /** `/d/<id>/<rest>` — `rest` is matched against the module-declared page routes. */
    const DEVICE_SUBPATH_RE = /^\/d\/([^/]+)(\/.+)$/;

    function deviceId(rawId: string): string | Response {
        let id: string;
        try {
            id = decodeURIComponent(rawId);
        } catch {
            return text("Invalid device id", 400);
        }
        return ID_RE.test(id) ? id : text("Invalid device id", 400);
    }

    return new Elysia({ name: "control-device-pages" }).all(
        "/d/*",
        authenticatedHandler(auth, (request, user) => {
            const url = new URL(request.url);
            const path = url.pathname;
            const sub = path.match(DEVICE_SUBPATH_RE);
            const modulePageName = sub ? modulePage(sub[2]) : undefined;
            if (sub && modulePageName) {
                const id = deviceId(sub[1]);
                if (id instanceof Response) return id;
                const device = devices.getDevice(id);
                if (!device || (device.owner ?? LOCAL_USER) !== user)
                    return notFound();
                return frontend.htmlResponse(modulePageName);
            }

            const match = path.match(DEVICE_PATH_RE);
            if (!match) return notFound();
            const [, rawId, slash, ws, page, pageSlash] = match;
            const id = deviceId(rawId);
            if (id instanceof Response) return id;
            const device = devices.getDevice(id);
            if (!device || (device.owner ?? LOCAL_USER) !== user)
                return notFound();

            const base = `/d/${encodeURIComponent(id)}/`;
            if (ws) {
                if (!originAllowed(request))
                    return text("Origin not allowed", 403);
                return upgradeRequired();
            }
            if (page)
                return pageSlash
                    ? frontend.htmlResponse(
                          page === "settings" ? "settings" : "setup",
                      )
                    : Response.redirect(`${base}${page}/`, 308);
            if (!slash) return Response.redirect(base, 308);
            const setupRequired =
                device.status?.setupRequired && !url.searchParams.has("ui");
            return frontend.htmlResponse(setupRequired ? "setup" : "index");
        }),
    );
}

function deviceViewerRoutes(s: PageServices, devices: Devices) {
    const { auth } = s;
    const VIEWER_PATH_RE = /^\/d\/([^/]+)\/ws\/?$/;
    type ViewerData = Extract<WsData, { kind: "viewer" }>;

    interface ViewerSocket {
        data: { connection: ViewerData | Response };
        raw: {
            readyState: number;
            send(message: string): number;
            close(code?: number, reason?: string): void;
            subscribe(topic: string): void;
        };
        close(code?: number, reason?: string): void;
    }

    function viewerConnection(
        request: Request,
        user: string,
    ): ViewerData | Response {
        const match = new URL(request.url).pathname.match(VIEWER_PATH_RE);
        if (!match) return notFound();
        let id: string;
        try {
            id = decodeURIComponent(match[1]);
        } catch {
            return text("Invalid device id", 400);
        }
        if (!ID_RE.test(id)) return text("Invalid device id", 400);
        const device = devices.getDevice(id);
        if (!device || (device.owner ?? LOCAL_USER) !== user) return notFound();
        if (!originAllowed(request)) return text("Origin not allowed", 403);
        return { kind: "viewer", id, user };
    }

    const socketHandlers = {
        open(ws: ViewerSocket) {
            const connection = ws.data.connection;
            if (connection instanceof Response)
                return ws.close(1011, "Missing viewer connection data");
            devices.open(socketAdapter(ws, connection));
        },
        message(ws: ViewerSocket, message: unknown) {
            const connection = ws.data.connection;
            if (connection instanceof Response) return;
            devices.message(
                socketAdapter(ws, connection),
                socketMessage(message),
            );
        },
        close(ws: ViewerSocket, code: number, reason: string) {
            const connection = ws.data.connection;
            if (connection instanceof Response) return;
            devices.close(socketAdapter(ws, connection), code, reason);
        },
    };

    return new Elysia({ name: "control-device-viewers" })
        .derive(({ request }) => {
            const user = auth.userFromRequest(request);
            const connection = user
                ? viewerConnection(request, user)
                : unauthenticatedResponse(auth, request);
            return { connection };
        })
        .onBeforeHandle(({ connection }) =>
            connection instanceof Response ? connection : undefined,
        )
        .all("/d/:id/ws", () => upgradeRequired())
        .all("/d/:id/ws/", () => upgradeRequired())
        .ws("/d/:id/ws", socketHandlers)
        .ws("/d/:id/ws/", socketHandlers);
}

/** Compose the four groups onto the page's plugin (init-time). */
export function mountDeviceRoutes(
    routes: Elysia,
    s: PageServices,
    devices: Devices,
): void {
    routes
        .use(deviceListRoutes(s, devices))
        .use(deviceConnectionRoutes(devices))
        .use(devicePageRoutes(s, devices))
        .use(deviceViewerRoutes(s, devices));
}
