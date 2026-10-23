import { Elysia } from "elysia";
import {
	notFound,
	originAllowed,
	text,
	upgradeRequired,
} from "../../../shared/http";
import { socketMessage } from "../../../shared/socket-message";
import type { createAuth } from "../auth";
import { ID_RE, LOCAL_USER, type WsData } from "../contracts";
import type { createDevices } from "../devices";
import { socketAdapter } from "../socket";
import { unauthenticatedResponse } from "./authenticated";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Devices = ReturnType<typeof createDevices>;
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

const VIEWER_PATH_RE = /^\/d\/([^/]+)\/ws\/?$/;

function viewerConnection(
	request: Request,
	user: string,
	devices: Devices,
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

function viewerSocketHandlers(devices: Devices) {
	return {
		open(ws: ViewerSocket) {
			const connection = ws.data.connection;
			if (connection instanceof Response)
				return ws.close(1011, "Missing viewer connection data");
			devices.open(socketAdapter(ws, connection));
		},
		message(ws: ViewerSocket, message: unknown) {
			const connection = ws.data.connection;
			if (connection instanceof Response) return;
			devices.message(socketAdapter(ws, connection), socketMessage(message));
		},
		close(ws: ViewerSocket, code: number, reason: string) {
			const connection = ws.data.connection;
			if (connection instanceof Response) return;
			devices.close(socketAdapter(ws, connection), code, reason);
		},
	};
}

export function deviceViewerRoutes(auth: Auth, devices: Devices) {
	const socketHandlers = viewerSocketHandlers(devices);
	const routes = new Elysia({ name: "control-device-viewers" })
		.derive(({ request }) => {
			const user = auth.userFromRequest(request);
			const connection = user
				? viewerConnection(request, user, devices)
				: unauthenticatedResponse(auth, request);
			return { connection };
		})
		.onBeforeHandle(({ connection }) =>
			connection instanceof Response ? connection : undefined,
		)
		.all("/d/:id/ws", () => upgradeRequired())
		.all("/d/:id/ws/", () => upgradeRequired());

	return routes
		.ws("/d/:id/ws", socketHandlers)
		.ws("/d/:id/ws/", socketHandlers);
}
