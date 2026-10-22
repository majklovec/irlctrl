import { Elysia } from "elysia";
import {
    notFound,
    originAllowed,
    text,
    upgradeRequired,
} from "../../http";
import type { createAuth } from "../auth";
import { ID_RE, LOCAL_USER } from "../contracts";
import type { createDevices } from "../devices";
import type { createFrontend } from "../../frontend";
import { authenticatedHandler } from "./authenticated";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type Devices = ReturnType<typeof createDevices>;
type Frontend = Awaited<ReturnType<typeof createFrontend>>;

const DEVICE_PATH_RE = /^\/d\/([^/]+)(?:(\/)(?:(ws)|(settings|setup)(\/)?)?)?$/;
const PIPELINE_EDIT_RE = /^\/d\/([^/]+)\/pipelines\/(new|edit\/[^/]+)\/?$/;

function deviceId(rawId: string): string | Response {
    let id: string;
    try {
        id = decodeURIComponent(rawId);
    } catch {
        return text("Invalid device id", 400);
    }
    return ID_RE.test(id) ? id : text("Invalid device id", 400);
}

export function devicePageRoutes(
    auth: Auth,
    devices: Devices,
    frontend: Frontend,
) {
    return new Elysia({ name: "control-device-pages" })
        .all(
            "/d/*",
            authenticatedHandler(auth, (request, user) => {
                const url = new URL(request.url);
                const path = url.pathname;
                const pipeline = path.match(PIPELINE_EDIT_RE);
                if (pipeline) {
                    const id = deviceId(pipeline[1]);
                    if (id instanceof Response) return id;
                    const device = devices.getDevice(id);
                    if (!device || (device.owner ?? LOCAL_USER) !== user)
                        return notFound();
                    return frontend.htmlResponse("pipelineedit");
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
                    device.status?.setupRequired &&
                    !url.searchParams.has("ui");
                return frontend.htmlResponse(
                    setupRequired ? "setup" : "index",
                );
            }),
        );
}
