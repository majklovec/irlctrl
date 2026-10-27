import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	deviceWidgetConfigFields,
	initWidgetHub,
	isChannelWidgetType,
	isFleetWidgetType,
	syncWidgetHub,
	validateDeviceWidgetConfig,
	WIDGET_SIZES,
	widgetConfigFields,
} from "../../shared/registry";
import type {
	ServerDashboard,
	ServerDashboardWidget,
	Status,
	WidgetConfigField,
} from "../../shared/types";
import { configFieldName } from "../../shared/types";
import {
	dashboardsTopic,
	event,
	LOCAL_USER,
	type Publish,
	WIDGET_HUB_TOPIC,
} from "./contracts";

const DASH_PATH_RE = /^\/api\/dashboards(?:\/([\w.-]{1,64}))?$/;
const DASH_COLUMNS = 12;

interface DashboardRow {
	id: string;
	owner: string;
	name: string;
	version: number;
	columns: number;
	widgets: string;
	position: number;
}

export function createDashboards({
	db,
	databaseFile,
	publish,
	ownsDevice,
	deviceExists,
	deviceStatus,
}: {
	db: Database | null;
	databaseFile: string;
	publish: Publish;
	ownsDevice: (id: string, user: string) => boolean;
	/** `true` when the device exists (owned or not), `false`/`null` when it no
	 * longer exists at all. Lets a save keep widgets bound to pruned devices
	 * (they simply cannot connect) instead of rejecting the whole dashboard. */
	deviceExists?: (id: string) => boolean | null | undefined;
	/** The device's last cached status (undefined before it reported one);
	 * device widgets with a config validate against it (e.g. the Buttons
	 * widget checks its action keys against `status.actions`). */
	deviceStatus?: (id: string) => Status | undefined;
}) {
	const DB_FILE = databaseFile;
	let dashboards: ServerDashboard[] = [];

	/** Parse the string-valued config of a widget against its module's declared fields. */
	function parseConfig(
		raw: unknown,
		fields: readonly WidgetConfigField[],
	): Record<string, string> {
		const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<
			string,
			unknown
		>;
		const fieldNames = fields.map(configFieldName);
		const config: Record<string, string> = {};
		for (const name of fieldNames) {
			const v = cfg[name];
			if (v !== undefined) {
				if (typeof v !== "string")
					throw new ApiError(`config.${name} must be a string`);
				config[name] = v.trim();
			} else config[name] = "";
		}
		for (const key of Object.keys(cfg)) {
			if (!fieldNames.includes(key))
				throw new ApiError(`Unknown config field: ${key}`);
		}
		return config;
	}

	/** Read `{x, y, w, h}` from an inbound widget payload (missing fields fall back to the type default). */
	function parseGrid(
		item: Record<string, unknown>,
		type: string,
	): { x: number; y: number; w: number; h: number } {
		// Widget types and their default sizes come from the module registrations
		const size = WIDGET_SIZES.get(type) ?? { w: 4, h: 4 };
		const toInt = (v: unknown, fallback: number, name: string) => {
			const n = v === undefined ? fallback : Number(v);
			if (!Number.isInteger(n))
				throw new ApiError(`${name} must be an integer`);
			return n;
		};
		const w = toInt(item.w, size.w, "w");
		const x = toInt(item.x, 0, "x");
		const y = toInt(item.y, 0, "y");
		const h = toInt(item.h, size.h, "h");
		if (x < 0 || y < 0 || w < 1 || h < 1)
			throw new ApiError("Widget position/size must be positive");
		if (x + w > DASH_COLUMNS)
			throw new ApiError("Widget extends past the grid");
		return { x, y, w, h };
	}

	function parseWidgets(
		raw: unknown,
		owner: string,
		strict = true,
	): ServerDashboardWidget[] {
		if (!Array.isArray(raw)) throw new ApiError("widgets is required");
		return raw.map((w) => {
			const item = (w && typeof w === "object" ? w : {}) as Record<
				string,
				unknown
			>;
			const type = item.type;
			if (typeof type !== "string" || !WIDGET_SIZES.has(type))
				throw new ApiError(`Unknown widget type: ${String(type)}`);
			const independent = isChannelWidgetType(type);
			const deviceId = item.deviceId;
			if (deviceId !== undefined && typeof deviceId !== "string") {
				throw new ApiError("Widget deviceId must be a string");
			}
			const grid = parseGrid(item, type);
			const visible = item.visible === true;
			const name =
				typeof item.name === "string" && item.name ? item.name : type;
			// Preserve a client-assigned id so new widgets keep stable gridstack
			// identity; assign one otherwise.
			const id =
				typeof item.id === "string" && item.id ? item.id : randomUUID();
			if (independent) {
				// Channel widgets are device-independent: they carry their own data
				// source parameters, declared by the widget module (the dashboard
				// API owns their hub). Values may be missing/empty — they can be
				// set in the add form and edited later in the widget config editor.
				return {
					id,
					deviceId: typeof deviceId === "string" ? deviceId : "",
					type,
					name,
					...grid,
					visible,
					config: parseConfig(item.config, widgetConfigFields(type)),
				};
			}
			// A device widget carries a config only when its module declares the
			// fields; the module may additionally validate it (strictly when the
			// dashboard is created, leniently on later saves). Fleet widgets are
			// offered once and name their devices in that config instead of
			// binding to one.
			const deviceFields = deviceWidgetConfigFields(type);
			const fleet = isFleetWidgetType(type);
			if (item.config !== undefined && deviceFields.length === 0)
				throw new ApiError(`The ${type} widget accepts no config`);
			const validate = (boundDevice: string): Record<string, string> => {
				const config = parseConfig(item.config, deviceFields);
				try {
					validateDeviceWidgetConfig(type, config, {
						strict,
						status: boundDevice ? deviceStatus?.(boundDevice) : undefined,
						deviceStatus: (id) => deviceStatus?.(id),
						ownsDevice: (id) => ownsDevice(id, owner),
						// Without a registry lookup every device counts as existing (so
						// a foreign id is rejected), like the device-bound branch below.
						deviceExists: (id) => !deviceExists || !!deviceExists(id),
					});
				} catch (err) {
					throw new ApiError(
						err instanceof Error ? err.message : "Invalid widget config",
					);
				}
				return config;
			};
			if (fleet)
				return {
					id,
					deviceId: "",
					type,
					name,
					...grid,
					visible,
					config: validate(""),
				};
			if (typeof deviceId !== "string" || deviceId === "")
				throw new ApiError("Widget needs a deviceId");
			// A widget may only bind to a device assigned to the dashboard's owner.
			// Exception on saves (strict=false): a widget bound to a device that no
			// longer exists is kept — the widget simply renders "No device" and the
			// user can remove it. Rejecting the whole save would brick any
			// dashboard that ever had a bound device pruned (even the save that
			// removes the widget itself would be rejected). The relaxation only
			// applies when the server can verify the device is actually gone, so
			// foreign/unknown devices are still rejected without a deviceExists
			// dependency.
			if (
				!ownsDevice(deviceId, owner) &&
				(strict || !deviceExists || deviceExists(deviceId))
			)
				throw new ApiError(`Device not available: ${deviceId}`);
			const config = deviceFields.length > 0 ? validate(deviceId) : undefined;
			return {
				id,
				deviceId,
				type,
				name,
				...grid,
				visible,
				...(config ? { config } : {}),
			};
		});
	}

	/** The in-memory dashboards reloaded from the database, in stored order. */
	function loadDashboards(): ServerDashboard[] {
		if (!db) return [];
		const rows = db
			.prepare("SELECT * FROM dashboards ORDER BY position")
			.all() as DashboardRow[];
		return rows.map((row) => {
			let widgets: ServerDashboardWidget[] = [];
			try {
				widgets = JSON.parse(row.widgets) as ServerDashboardWidget[];
			} catch {
				// Corrupt row: keep the dashboard shell, drop its widgets
				console.warn(
					`[dashboards] ${row.id}: dropping widgets — the stored JSON is unparsable`,
				);
			}
			return {
				id: row.id,
				owner: row.owner,
				name: row.name,
				version: row.version,
				widgets,
				columns: row.columns,
			};
		});
	}

	/** Persist the whole in-memory list (dashboards are small; a full rewrite in
	 * one transaction is simplest and always leaves the table consistent). */
	function saveDashboards(): void {
		if (!db) return;
		try {
			db.transaction(() => {
				db.prepare("DELETE FROM dashboards").run();
				const ins = db.prepare(
					'INSERT INTO dashboards (id, owner, name, version, "columns", widgets, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
				);
				dashboards.forEach((d, i) =>
					ins.run(
						d.id,
						d.owner ?? LOCAL_USER,
						d.name,
						d.version,
						d.columns,
						JSON.stringify(d.widgets),
						i,
					),
				);
			})();
		} catch (err: unknown) {
			console.error(`[dashboards] persist ${DB_FILE}:`, err);
		}
	}

	dashboards = loadDashboards();

	/** Channel widget hubs needed by the persisted dashboards; fans out to dashboard viewers. */
	initWidgetHub((msg) => publish(WIDGET_HUB_TOPIC, msg));
	const syncHub = (): void => syncWidgetHub(dashboards);
	syncHub();

	class ApiError extends Error {
		constructor(
			message: string,
			readonly code = 400,
		) {
			super(message);
		}
	}

	function dashError(code: number, message: string): Response {
		return Response.json({ ok: false, error: message, code });
	}

	/** Push a dashboard change to the owner's live dashboards topic, so their open
	 * dashboards (view/edit pages) re-render without a refresh. */
	function broadcastDashboard(d: ServerDashboard): void {
		publish(
			dashboardsTopic(d.owner ?? LOCAL_USER),
			event("dashboards.changed", d),
		);
	}

	/** Dashboards owned by `user`, in stored order. Ownerless (legacy) dashboards
	 * belong to the `local` profile. */
	const dashboardsFor = (user: string) =>
		dashboards.filter((d) => (d.owner ?? LOCAL_USER) === user);

	async function dashApi(
		req: Request,
		url: URL,
		user: string,
	): Promise<Response> {
		try {
			const m = url.pathname.match(DASH_PATH_RE);
			if (!m)
				return Response.json({ ok: false, error: "Not found", code: 404 });
			const id = m[1];
			if (!id) {
				// The list is always scoped to the requesting user
				if (req.method === "GET")
					return Response.json({
						ok: true,
						dashboards: dashboardsFor(user),
					});
				if (req.method === "POST") {
					const body = (await req.json()) as {
						name?: unknown;
						widgets?: unknown;
					};
					const name = typeof body.name === "string" ? body.name.trim() : "";
					if (!name) return dashError(400, "Dashboard needs a name");
					const dashboard: ServerDashboard = {
						id: randomUUID(),
						owner: user,
						name,
						version: 1,
						columns: DASH_COLUMNS,
						widgets: parseWidgets(body.widgets, user),
					};
					dashboards.push(dashboard);
					saveDashboards();
					syncHub();
					broadcastDashboard(dashboard);
					return Response.json(
						{ ok: true, dashboard, dashboards: dashboardsFor(user) },
						{ status: 201 },
					);
				}
				return Response.json({
					ok: false,
					error: "Method not allowed",
					code: 405,
				});
			}
			// Mutations need a body (JSON); the device list is a separate GET.
			// Other users' dashboards are invisible (404, not just hidden).
			const dashboardsById = dashboards.find(
				(d) => d.id === id && (d.owner ?? LOCAL_USER) === user,
			);
			if (req.method === "DELETE") {
				if (!dashboardsById) return dashError(404, "Unknown dashboard");
				dashboards = dashboards.filter((d) => d.id !== id);
				saveDashboards();
				syncHub();
				publish(
					dashboardsTopic(user),
					event("dashboards.changed", { id, deleted: true }),
				);
				return Response.json({ ok: true, dashboards: dashboardsFor(user) });
			}
			if (req.method === "PUT") {
				if (!dashboardsById) return dashError(404, "Unknown dashboard");
				const body = (await req.json()) as {
					name?: unknown;
					widgets?: unknown;
					version?: unknown;
				};
				const name = typeof body.name === "string" ? body.name.trim() : "";
				if (!name) return dashError(400, "Dashboard needs a name");
				// Optimistic concurrency: the client must echo the version it based
				// the changes on, or we reject and let it rebase against `current`.
				if (Number(body.version) !== dashboardsById.version) {
					return Response.json(
						{
							ok: false,
							error: "version conflict",
							current: dashboardsById,
						},
						{ status: 409 },
					);
				}
				dashboardsById.name = name;
				dashboardsById.widgets = parseWidgets(body.widgets, user, false);
				dashboardsById.version += 1;
				saveDashboards();
				syncHub();
				broadcastDashboard(dashboardsById);
				return Response.json({
					ok: true,
					dashboard: dashboardsById,
					dashboards: dashboardsFor(user),
				});
			}
			if (req.method === "GET") {
				if (!dashboardsById) return dashError(404, "Unknown dashboard");
				return Response.json({ ok: true, dashboard: dashboardsById });
			}
			return Response.json({
				ok: false,
				error: "Method not allowed",
				code: 405,
			});
		} catch (err: unknown) {
			const code = err instanceof ApiError ? err.code : 500;
			return dashError(
				code,
				err instanceof Error ? err.message : "Internal error",
			);
		}
	}

	return { dashApi, dashboardsFor };
}
