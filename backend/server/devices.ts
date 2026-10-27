import { text } from "../../shared/http";
import { isLanguage, type Language, translate } from "../../shared/i18n";
import {
    LOG_MAX,
    type LogEntry,
    type LogEvent,
    type LogLevel,
} from "../../shared/logMessages";
import { dashboardActionsFor } from "../../shared/registry";
import type { DeviceInfo, DeviceSummary, Status } from "../../shared/types";
import { parseJsonObject, textOf } from "../../shared/util";
import { COLOR_RE, isRole, type Role } from "../../shared/validate";
import {
    devicesTopic,
    event,
    ID_RE,
    LOCAL_USER,
    type Publish,
    type Socket,
    viewersTopic,
    type WsData,
} from "./contracts";

const STALE_DEVICE_MS = 5 * 60 * 1000;
const PRUNE_INTERVAL_MS = 30 * 1000;
// A flapping device link loses forwarded requests; fail before the client's
// 30 s timeout so the page surfaces the error and retries promptly.
const REQUEST_TIMEOUT_MS = 20_000;

interface Device {
    /** Stable uuid; the key of this entry. Hostnames change, so the id does not */
    id: string;
    /** User this device is assigned to (derived from the connect token) */
    owner?: string;
    hostname?: string; // display name, from the device's hello
    color?: string; // the device's header color, from the device's hello
    language?: Language; // UI language, from the device's hello
    role?: Role; // device type, from the upgrade header / hello / status
    version?: string; // app build stamp, from the device's hello (absent on pre-version builds)
    ws: Socket | null;
    address?: string;
    connectedAt?: number;
    lastSeen?: number;
    statusMsg?: string; // last serialized status event, replayed to new viewers
    /** Last retained module frame per event (`retain: true`), replayed to new viewers */
    retained: Map<string, string>;
    /** Device-list summary fields carried by module frames (`summary`), per module, live only */
    liveSummary: Map<string, Record<string, unknown>>;
    status?: Status;
    statusAt?: number;
    log: LogEntry[]; // the device's own event log, as last pushed
    serverLog: LogEntry[]; // online / offline entries added here
}

interface Pending {
    deviceId: string;
    viewer: Socket;
    clientId: unknown;
    method: string;
    timer: ReturnType<typeof setTimeout>;
}

export function createDevices({
    publish,
    userForToken,
}: {
    publish: Publish;
    userForToken: (token: string | null) => string | null;
}) {
    const devices = new Map<string, Device>();
    const pending = new Map<number, Pending>();
    let nextRequestId = 1;
    let nextServerLogId = 1;

    const newDevice = (id: string): Device => ({
        id,
        ws: null,
        retained: new Map(),
        liveSummary: new Map(),
        log: [],
        serverLog: [],
    });

    const deviceFor = (id: string): Device => {
        let d = devices.get(id);
        if (!d) devices.set(id, (d = newDevice(id)));
        return d;
    };

    const deviceInfo = (d: Device): DeviceInfo => ({
        id: d.id,
        hostname: d.hostname,
        color: d.color,
        language: d.language,
        role: d.role,
        version: d.version,
        online: d.ws !== null,
        connectedAt: d.connectedAt,
        lastSeen: d.lastSeen,
        address: d.address,
    });

    const deviceEvent = (d: Device) => event("device", deviceInfo(d));
    const logEvent = (data: LogEvent) => event("log", data);
    const publishToDevice = (d: Device, msg: string) =>
        publish(viewersTopic(d.id), msg);

    const logHistory = (d: Device) =>
        logEvent({
            reset: true,
            entries: [...d.log, ...d.serverLog]
                .sort((a, b) => a.at - b.at)
                .slice(-LOG_MAX),
        });

    /** Keep the newest LOG_MAX entries. */
    const trimLog = (log: LogEntry[]) =>
        log.splice(0, Math.max(0, log.length - LOG_MAX));

    function addServerLog(d: Device, level: LogLevel, message: string): void {
        const entry: LogEntry = {
            id: nextServerLogId++,
            origin: "server",
            at: Date.now(),
            level,
            section: "Device",
            message,
        };
        d.serverLog.push(entry);
        trimLog(d.serverLog);
        publishToDevice(d, logEvent({ entries: [entry] }));
    }

    /** Apply a device `log` event to the cache; returns the message to forward to viewers. */
    function updateDeviceLog(
        d: Device,
        data: LogEvent | undefined,
        raw: string,
    ): string | null {
        if (!data || !Array.isArray(data.entries)) return null;
        if (data.reset) {
            d.log = data.entries.slice(-LOG_MAX);
            return logHistory(d);
        }
        for (const e of data.entries) {
            const i = d.log.findIndex((x) => x.id === e.id);
            if (i >= 0) d.log[i] = e;
            else d.log.push(e);
        }
        trimLog(d.log);
        return raw;
    }

    const errorResponse = (
        id: unknown,
        method: string,
        error: string,
        code: number,
    ) =>
        JSON.stringify({
            type: "response",
            id,
            method,
            ok: false,
            error,
            code,
        });

    function sendToViewer(viewer: Socket, msg: string): void {
        if (viewer.readyState === WebSocket.OPEN) viewer.send(msg);
    }

    function failPending(
        predicate: (p: Pending) => boolean,
        error: string,
        code: number,
        notify = true,
    ): void {
        for (const [sid, p] of pending) {
            if (!predicate(p)) continue;
            clearTimeout(p.timer);
            pending.delete(sid);
            if (notify)
                sendToViewer(
                    p.viewer,
                    errorResponse(p.clientId, p.method, error, code),
                );
        }
    }

    function forwardRequest(
        device: Device,
        deviceSocket: Socket,
        viewer: Socket,
        clientId: unknown,
        method: string,
        params: unknown,
    ): void {
        const sid = nextRequestId++;
        const timer = setTimeout(() => {
            pending.delete(sid);
            sendToViewer(
                viewer,
                errorResponse(clientId, method, "device did not respond", 504),
            );
        }, REQUEST_TIMEOUT_MS);
        pending.set(sid, {
            deviceId: device.id,
            viewer,
            clientId,
            method,
            timer,
        });
        deviceSocket.send(JSON.stringify({ id: sid, method, params }));
    }

    /** Apply the device's self-reported parameters (hello / status); returns whether any changed. */
    function updateDevice(
        d: Device,
        fields: Partial<
            Pick<Device, "role" | "hostname" | "color" | "language" | "version">
        >,
    ): boolean {
        let changed = false;
        for (const [key, value] of Object.entries(fields) as [
            keyof typeof fields,
            string | undefined,
        ][]) {
            if (value === undefined || d[key] === value) continue;
            (d as unknown as Record<string, string>)[key] = value;
            changed = true;
        }
        return changed;
    }

    function onDeviceMessage(d: Device, raw: unknown): void {
        d.lastSeen = Date.now();
        const text = textOf(raw);
        const msg = parseJsonObject(text);
        if (!msg) return;

        if (msg.type === "response" && typeof msg.id === "number") {
            const p = pending.get(msg.id);
            if (!p || p.deviceId !== d.id) return;
            clearTimeout(p.timer);
            pending.delete(msg.id);
            sendToViewer(p.viewer, JSON.stringify({ ...msg, id: p.clientId }));
            return;
        }

        if (msg.type === "request") {
            onDeviceRequest(d, msg);
            return;
        }

        if (msg.type === "event") {
            let forward = text;
            if (msg.event === "status") {
                const status = msg.data as Status;
                // The Buttons widget's catalogue rides on the cached status: the
                // actions of every module enabled on the device, from the
                // registrations (the device itself does not know the dashboard).
                if (status && typeof status === "object")
                    status.actions = dashboardActionsFor(status);
                d.status = status;
                d.statusMsg = forward = JSON.stringify({
                    ...msg,
                    data: status,
                });
                d.statusAt = Date.now();
                const role = d.status?.role;
                // A role change is structural — refresh the list at once for it
                if (
                    updateDevice(d, { role: isRole(role) ? role : undefined })
                ) {
                    publishToDevice(d, deviceEvent(d));
                    publishDeviceList(true);
                    return;
                }
                publishDeviceList();
            } else if (msg.event === "log") {
                const forward = updateDeviceLog(
                    d,
                    msg.data as LogEvent | undefined,
                    text,
                );
                if (forward) publishToDevice(d, forward);
                return;
            }
            if (typeof msg.event === "string") {
                if (msg.retain === true) d.retained.set(msg.event, forward);
                const summary = msg.summary;
                if (summary && typeof summary === "object") {
                    d.liveSummary.set(
                        String(msg.module ?? ""),
                        summary as Record<string, unknown>,
                    );
                    publishDeviceList();
                }
            }
            publishToDevice(d, forward);
            return;
        }

        if (msg.type === "hello") {
            if (msg.id !== d.id)
                console.warn(
                    `[device ${d.id}] hello announced a different id (${String(msg.id)}) — ignored`,
                );
            // The per-uuid parameters the device reports about itself; a color change
            // re-themes the list dot, a hostname change the display name
            const changed = updateDevice(d, {
                role: isRole(msg.role) ? msg.role : undefined,
                hostname:
                    typeof msg.hostname === "string" && msg.hostname !== ""
                        ? msg.hostname
                        : undefined,
                color:
                    typeof msg.color === "string" && COLOR_RE.test(msg.color)
                        ? msg.color
                        : undefined,
                language: isLanguage(msg.language) ? msg.language : undefined,
                // Absent on builds that predate version reporting — stays undefined, which the UI flags as "old app"
                version:
                    typeof msg.version === "string" && msg.version !== ""
                        ? msg.version
                        : undefined,
            });
            if (changed) {
                publishToDevice(d, deviceEvent(d));
                publishDeviceList(true);
            }
        }
    }

    /** Device-initiated request: `devices.list` is answered by the server itself
     * (the registry); anything else with a `target` is forwarded to that device
     * like a viewer request, and the response travels back over the origin's socket. */
    function onDeviceRequest(
        origin: Device,
        msg: Record<string, unknown>,
    ): void {
        const id = msg.id;
        if (typeof id !== "number") return;
        const method = typeof msg.method === "string" ? msg.method : "";
        if (!method) return;
        const respond = (payload: string): void => {
            const ws = origin.ws;
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
        };

        if (method === "devices.list") {
            // Devices only see their own user's assignments
            respond(
                JSON.stringify({
                    type: "response",
                    id,
                    method,
                    ok: true,
                    result: summaries(origin.owner ?? LOCAL_USER),
                }),
            );
            return;
        }

        const targetId = typeof msg.target === "string" ? msg.target : "";
        const target = targetId ? devices.get(targetId) : undefined;
        if (!target?.ws) {
            respond(errorResponse(id, method, "device offline", 503));
            return;
        }

        const originWs = origin.ws;
        if (!originWs) {
            respond(errorResponse(id, method, "device offline", 503));
            return;
        }
        const params =
            msg.params &&
            typeof msg.params === "object" &&
            !Array.isArray(msg.params)
                ? msg.params
                : {};
        forwardRequest(target, target.ws, originWs, id, method, params);
    }

    function onViewerMessage(
        ws: Socket,
        deviceId: string,
        _user: string,
        raw: unknown,
    ): void {
        const msg = parseJsonObject(textOf(raw));
        if (!msg) {
            ws.send(errorResponse(null, "", "Invalid JSON object", 400));
            return;
        }
        const clientId = msg.id ?? null;
        const method = typeof msg.method === "string" ? msg.method : "";
        if (!method) {
            ws.send(errorResponse(clientId, method, "method is required", 400));
            return;
        }
        const d = devices.get(deviceId);
        if (!d?.ws) {
            ws.send(errorResponse(clientId, method, "device offline", 503));
            return;
        }

        forwardRequest(d, d.ws, ws, clientId, method, msg.params);
    }

    const deviceSummary = (d: Device): DeviceSummary => ({
        ...deviceInfo(d),
        statusAt: d.statusAt,
        modules: d.status?.modules,
        // Module-contributed summary fields: from the status (`summary`) and
        // from live module frames (`summary` on the frame)
        ...(d.status?.summary ?? {}),
        ...Object.assign({}, ...d.liveSummary.values()),
    });

    /** Device list scoped to one user's assignments. */
    function summaries(user: string): DeviceSummary[] {
        return [...devices.values()]
            .filter((d) => (d.owner ?? LOCAL_USER) === user)
            .map(deviceSummary)
            .sort(
                (a, b) =>
                    Number(b.online) - Number(a.online) ||
                    a.id.localeCompare(b.id),
            );
    }

    /** The set of users with at least one registered device. */
    const deviceOwners = (): string[] => {
        const owners = new Set<string>();
        for (const d of devices.values()) owners.add(d.owner ?? LOCAL_USER);
        return [...owners];
    };

    // The per-device push cadence (2 s stats × N devices + 30 s status) would
    // flood the dashboard feed with a full-list re-broadcast even when nothing
    // visible changed — so the list is throttled: at most once per tick (2 s),
    // and only when a visible summary field changed (timestamps excluded —
    // they are refreshed by the slow pass below).
    const LIST_TICK_MS = 2_000;
    const LIST_SLOW_PASS_MS = 30_000;
    const VOLATILE_KEYS = new Set<PropertyKey>(["lastSeen", "statusAt"]);
    /** JSON of the summary without the per-push volatile timestamps. */
    const stableFingerprint = (list: DeviceSummary[]): string =>
        JSON.stringify(
            list.map((d) =>
                Object.fromEntries(
                    Object.entries(d).filter(([k]) => !VOLATILE_KEYS.has(k)),
                ),
            ),
        );

    // Per-user fingerprints: a change to user A's devices must not re-kick
    // user B's (unchanged) list feed.
    const listFingerprints = new Map<string, string>();
    let lastListsFingerprint = "";
    let listPublishedAt = 0;

    /** One stable fingerprint over every user's current list. */
    const listsFingerprint = (): string =>
        deviceOwners()
            .sort()
            .map((u) => `${u}:${stableFingerprint(summaries(u))}`)
            .join("|");

    function publishDeviceListNow(): void {
        listPublishedAt = Date.now();
        lastListsFingerprint = listsFingerprint();
        // Publish per owner so each client only hears about its own devices.
        for (const user of deviceOwners()) {
            const list = summaries(user);
            const fingerprint = stableFingerprint(list);
            if (listFingerprints.get(user) === fingerprint) continue;
            listFingerprints.set(user, fingerprint);
            publish(devicesTopic(user), event("devices.changed", list));
        }
    }

    /** Re-broadcast the per-user lists to the live-feed subscribers; each list
     * is identical to what the pages fetch from /api/devices. Throttled to at
     * most one broadcast per tick and skipped when nothing visible changed —
     * except structural events (connect / disconnect / identity), which pass
     * immediate. */
    function publishDeviceList(immediate = false): void {
        const now = Date.now();
        if (!immediate && now - listPublishedAt < LIST_TICK_MS) return;
        if (immediate || listsFingerprint() !== lastListsFingerprint)
            publishDeviceListNow();
    }

    /** Device connection (`/device`): authenticate and describe the socket context. */
    function deviceConnection(
        req: Request,
        url: URL,
        address: string,
    ): WsData | Response {
        const id =
            req.headers.get("x-device-id") ?? url.searchParams.get("id") ?? "";
        const token =
            req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ??
            "";
        if (!ID_RE.test(id)) return text("Missing or invalid x-device-id", 400);
        // The connect token assigns the device to the presenting user
        const user = userForToken(token);
        if (!user) {
            console.warn(
                `[device ${id}] rejected: bad token from ${address || "?"}`,
            );
            return text("Unauthorized", 401);
        }
        const existing = devices.get(id);
        if (existing && (existing.owner ?? LOCAL_USER) !== user) {
            console.warn(
                `[device ${id}] rejected from ${address || "?"}: assigned to a different user`,
            );
            return text("Forbidden", 403);
        }
        const role = req.headers.get("x-device-role");
        return {
            kind: "device",
            id,
            address,
            owner: user,
            role: isRole(role) ? role : undefined,
        };
    }

    function open(ws: Socket): void {
        const { data } = ws;
        if (data.kind === "dashboards") return;
        if (data.kind === "device") {
            const d = deviceFor(data.id);
            if (d.ws) d.ws.close(4001, "replaced by a new connection");
            d.ws = ws;
            d.address = data.address;
            d.owner = data.owner;
            d.role = data.role ?? d.role;
            d.connectedAt = d.lastSeen = Date.now();
            console.log(`[device ${d.id}] connected from ${data.address}`);
            publishToDevice(d, deviceEvent(d));
            addServerLog(
                d,
                "info",
                translate(d.language, "srv.online", {
                    address: data.address,
                }),
            );
            publishDeviceList(true);
            return;
        }
        // Viewers of never-seen devices must not grow the registry
        const d = devices.get(data.id) ?? newDevice(data.id);
        ws.subscribe(viewersTopic(d.id));
        ws.send(deviceEvent(d));
        ws.send(logHistory(d));
        if (d.statusMsg) ws.send(d.statusMsg);
        for (const frame of d.retained.values()) ws.send(frame);
    }

    function message(ws: Socket, raw: unknown): void {
        const { data } = ws;
        if (data.kind === "dashboards") return;
        if (data.kind === "viewer")
            return onViewerMessage(ws, data.id, data.user, raw);
        const d = devices.get(data.id);
        if (d && d.ws === ws) onDeviceMessage(d, raw);
    }

    function close(ws: Socket, code: number, reason: string): void {
        const { data } = ws;
        if (data.kind === "dashboards") return;
        if (data.kind === "viewer") {
            failPending((p) => p.viewer === ws, "", 0, false);
            return;
        }
        const d = devices.get(data.id);
        if (!d || d.ws !== ws) return; // an older, replaced connection
        d.ws = null;
        d.retained.clear(); // live telemetry; viewers clear it on the offline device event
        d.liveSummary.clear();
        const why = `${code}${reason ? `: ${reason}` : ""}`;
        console.log(`[device ${d.id}] disconnected (${why})`);
        failPending((p) => p.deviceId === d.id, "device disconnected", 503);
        publishToDevice(d, deviceEvent(d));
        addServerLog(
            d,
            "warn",
            translate(d.language, "srv.offline", { reason: why }),
        );
        publishDeviceList(true);
    }

    function startMaintenance(): void {
        // A slow pass keeps the volatile time columns accurate while devices idle.
        setInterval(publishDeviceListNow, LIST_SLOW_PASS_MS);

        // A device entry is dropped once it has been silent for this long.
        setInterval(() => {
            const now = Date.now();
            for (const d of [...devices.values()]) {
                const seen = d.lastSeen ?? d.connectedAt ?? 0; // never-heard-from phantoms use epoch 0
                if (now - seen <= STALE_DEVICE_MS) continue;
                d.ws?.close(4000, "removed after inactivity");
                devices.delete(d.id);
                failPending(
                    (p) => p.deviceId === d.id,
                    "device disconnected",
                    503,
                );
                publishToDevice(d, deviceEvent(d));
                publishDeviceList(true);
                console.log(
                    `[device ${d.id}] removed: no heartbeat for >${STALE_DEVICE_MS / 60000} minutes`,
                );
            }
        }, PRUNE_INTERVAL_MS);
    }

    return {
        getDevice: (id: string) => devices.get(id),
        ownsDevice: (id: string, user: string): boolean => {
            const d = devices.get(id);
            return !!d && (d.owner ?? LOCAL_USER) === user;
        },
        summaries,
        deviceConnection,
        open,
        message,
        close,
        startMaintenance,
    };
}
