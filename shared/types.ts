/*
 * Core wire vocabulary shared by the device UI, the device list and the
 * control server: the status / settings / setup / device-list envelopes and
 * the dashboard shapes.
 *
 * Module-specific wire shapes (encoder, srtla, obs-controller, ssh,
 * chat, stats) live in the owning module's `modules/<id>/types.ts`; a module
 * narrows these envelopes with its own view types (e.g. `Status & {...}`) and
 * the core never names a module field. The modules/ tree may not contribute
 * to this file.
 */
import type { Language } from "./languages";
import type { DashboardActionEntry } from "./module-contract";
import type { Role, RoleDefinition } from "./roles";

export type { DashboardAction, DashboardActionEntry } from "./module-contract";
export type { Role };

/** One module's slice of the modules view: its enabled flag plus its non-secret settings. */
export interface ModuleSliceView {
    enabled: boolean;
    [field: string]: unknown;
}
/** Module system view: enabled flags + non-secret settings per module id (secrets come back as `{configured}`). */
export type ModulesView = Record<string, ModuleSliceView>;

/** The device status envelope; the modules' status fragments are deep-merged in. */
export interface Status {
    role: Role;
    setupRequired: boolean;
    state: {
        autostart: boolean;
        [key: string]: unknown;
    };
    modules: ModulesView;
    /** Device-list summary fields contributed by the modules (the control server copies them). */
    summary?: Record<string, unknown>;
    /** Operator actions of the enabled modules — merged in by the control server
     * from the module registrations (absent on a status read straight from the device). */
    actions?: readonly DashboardActionEntry[];
    [key: string]: unknown;
}

/** Device settings as returned by `settings.get` / accepted by `settings.update`. */
export interface Settings {
    /** Stable identity on the control server; hostnames change, the uuid does not */
    uuid: string;
    hostname: string;
    role: string;
    remoteUrl: string;
    hasRemoteToken: boolean;
    color: string;
    language?: string;
    roleDefinitions?: readonly RoleDefinition[];
    [key: string]: unknown;
}

/** First-run response; modules narrow it with the resources they own. */
export interface SetupInfo {
    required: boolean;
    hostname: string;
    color: string;
    language: string;
    roleDefinitions: readonly RoleDefinition[];
    [key: string]: unknown;
}

/** Sent only when the UI is served by the control server (server.ts) for a remote device. */
export interface DeviceInfo {
    /** Stable device uuid (the registry key on the control server) */
    id: string;
    role?: Role;
    online: boolean;
    connectedAt?: number;
    lastSeen?: number;
    address?: string;
    /** Display name; hostnames change, the id does not */
    hostname?: string;
    /** Device header color, used by the list's heartbeat dot */
    color?: string;
    /** UI language the device was set to (see LANGUAGE_INFO in shared/i18n.ts) */
    language?: Language;
    /** App build stamp (git short SHA) the device reports in its hello; undefined on builds predating version reporting */
    version?: string;
}

/** One row of the control server's `GET /api/devices`: the device info plus
 * the module-contributed summary fields (status `summary` and live frame
 * `summary` patches); modules narrow it with the fields they contribute. */
export interface DeviceSummary extends DeviceInfo {
    statusAt?: number;
    /** Enabled modules, offered by the dashboards page when composing widgets */
    modules?: ModulesView;
    [key: string]: unknown;
}

/** Opaque dashboard widget key declared by a frontend module. */
export type WidgetType = string;

/**
 * A channel widget's config parameter, declared by its module in editor order.
 * A bare string is a free-text field (its value is the parameter name);
 * `{name, type:"select", options}` is a dropdown; `{name, type:"hidden"}` is
 * retained in config but not shown in the editor.
 */
export type WidgetConfigField =
    | string
    | { name: string; type: "select"; options: readonly string[] }
    | { name: string; type: "hidden" };

export type VisibleWidgetConfigField = Exclude<
    WidgetConfigField,
    { name: string; type: "hidden" }
>;

/** Remove retained-but-hidden config entries before creating keyed field vnodes. */
export const visibleWidgetConfigFields = (
    fields: readonly WidgetConfigField[],
): VisibleWidgetConfigField[] =>
    fields.filter(
        (field): field is VisibleWidgetConfigField =>
            typeof field === "string" || field.type !== "hidden",
    );

/** The parameter name a config field writes to the widget's `config` record. */
export const configFieldName = (f: WidgetConfigField): string =>
    typeof f === "string" ? f : f.name;

/**
 * Server-side dashboards: composed in the control server's dashboards page from
 * widgets that each pull one module's view off a selected device.
 */
export interface ServerDashboardWidget {
    /** Stable widget id, assigned by the server */
    id: string;
    /** The device this widget's module data comes from ("" for channel widgets) */
    deviceId: string;
    type: WidgetType;
    name: string;
    /** Grid position (0-indexed, 12 columns) and extent, in grid units. */
    x: number;
    y: number;
    w: number;
    h: number;
    /** Hidden widgets keep their position/size; they are not rendered. */
    visible: boolean;
    /** The widget's own parameters, declared by its module's `configFields`
     * (channel widgets: their data source; device widgets: optional, e.g. the
     * Buttons layout). The core stores an opaque record and never names its fields. */
    config?: Record<string, string>;
}
export interface ServerDashboard {
    id: string;
    /** User profile that owns this dashboard (server-assigned). */
    owner?: string;
    name: string;
    /** Dashboard accent color, used by the list's dot */
    color?: string;
    /** Monotonic; bumped on every update. Used for optimistic concurrency. */
    version: number;
    widgets: ServerDashboardWidget[];
    /** Columns in the grid. Fixed at 12 for now; stored for forward-compat. */
    columns: number;
}

/** Grid size in units of one widget: `{w, h}`. */
export interface GridSize {
    w: number;
    h: number;
}
