/*
 * Device-local HTTP and WebSocket API, composed from page and RPC plugins.
 * The same socket protocol is also spoken by the outbound remote connection.
 */
import { Elysia } from "elysia";
import { createFrontend } from "../../shared/frontend";
import { devicePagesPlugin } from "./api/pages";
import { deviceRpcPlugin } from "./api/rpc";
import { API_HOST, API_PORT } from "./config";
import { addStatusSink } from "./push";

export async function createDeviceApiApp() {
	const frontend = await createFrontend(
		new URL("../../frontend/", import.meta.url),
	);
	return new Elysia({ name: "device-api" })
		.use(devicePagesPlugin(frontend))
		.use(deviceRpcPlugin());
}

export async function startApiServer(): Promise<void> {
	const app = (await createDeviceApiApp()).listen({
		hostname: API_HOST,
		port: API_PORT,
	});
	const server = app.server;
	if (!server) throw new Error("Elysia failed to start the device API");

	addStatusSink({
		active: () => server.subscriberCount("status") > 0,
		send: (msg) => server.publish("status", msg),
	});

	const url = `ws://${API_HOST}:${server.port}/ws`;
	console.log(`Web UI on http://${API_HOST}:${server.port}/`);
	console.log(`WebSocket API listening on ${url}`);
	console.log(
		`Try:  bunx wscat -c ${url}  then send {"id":1,"method":"status"}`,
	);
}
