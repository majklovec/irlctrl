/*
 * Deck widget — a virtual StreamDeck on the dashboard. One widget drives
 * any number of devices: every button names its device and one of that
 * device's module actions. The layout is stored under the `buttons` config
 * field as JSON (the dashboard API keeps widget configs as string records);
 * these are the shapes the server-side validation (backend.ts) and the
 * widget (frontend.tsx) share.
 */
import type { DashboardActionEntry } from "../../shared/types";

export type { DashboardActionEntry };

/** One configured button: a device, an action of its catalogue, optional
 * overrides, and its slot in the widget's internal grid (cells, 12 wide). */
export interface ButtonConfig {
    /** The device the action fires on. */
    deviceId: string;
    /** `<module>.<action>` — `DashboardActionEntry.key`. */
    actionId: string;
    labelOverride?: string;
    iconOverride?: string;
    /** Merged over the action's default params (`paramsOverride` wins). */
    paramsOverride?: Record<string, unknown>;
    x?: number;
    y?: number;
    /** The key's extent in grid cells (always present together with `x`/`y`). */
    w?: number;
    h?: number;
}

// The internal grid a layout is arranged on: 12 columns (a 4-cells-wide widget
// hosts 60 px cells, exactly like the dashboard grid) and 60 px-tall cells.
export const DECK_GRID_COLUMNS = 12;
export const DECK_CELL_PX = 60;
/** A freshly added key spans 2×2 cells; it can grow to a quarter of the grid. */
export const DECK_CELL_DEFAULT = { w: 2, h: 2 } as const;
export const DECK_CELL_MIN = { w: 1, h: 1 } as const;
export const DECK_CELL_MAX = { w: 6, h: 6 } as const;

const isCount = (v: unknown, min: number): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= min;

const hasPosition = (b: ButtonConfig): boolean =>
    b.x !== undefined &&
    b.y !== undefined &&
    b.w !== undefined &&
    b.h !== undefined;

/** Which cells a key occupies. */
function cells(b: ButtonConfig): {
    x: number;
    y: number;
    w: number;
    h: number;
} {
    return { x: b.x ?? 0, y: b.y ?? 0, w: b.w ?? 0, h: b.h ?? 0 };
}

const cellKey = (x: number, y: number): string => `${x}\0${y}`;

/** First free slot (row-major, top to bottom) in `occupied` that fits `w`×`h`. */
function firstFreeSlot(
    occupied: ReadonlySet<string>,
    w: number,
    h: number,
): { x: number; y: number; w: number; h: number } {
    for (let y = 0; ; y++)
        for (let x = 0; x + w <= DECK_GRID_COLUMNS; x++) {
            let free = true;
            for (let dy = 0; dy < h && free; dy++)
                for (let dx = 0; dx < w && free; dx++)
                    free = !occupied.has(cellKey(x + dx, y + dy));
            if (free) return { x, y, w, h };
        }
}

/** First free slot (row-major) not covered by the given keys' stored slots. */
export function nextButtonSlot(
    buttons: readonly ButtonConfig[],
    w: number = DECK_CELL_DEFAULT.w,
    h: number = DECK_CELL_DEFAULT.h,
): { x: number; y: number; w: number; h: number } {
    const occupied = new Set<string>();
    for (const b of buttons)
        if (hasPosition(b)) {
            const c = cells(b);
            for (let dy = 0; dy < c.h; dy++)
                for (let dx = 0; dx < c.w; dx++)
                    occupied.add(cellKey(c.x + dx, c.y + dy));
        }
    return firstFreeSlot(occupied, w, h);
}

/**
 * Every key guaranteed a slot: stored positions are kept, the rest are filled
 * in layout order into the first free slots. Pure — returns new objects.
 */
export function layoutButtons(
    buttons: readonly ButtonConfig[],
): ButtonConfig[] {
    const occupied = new Set<string>();
    const claim = (x: number, y: number, w: number, h: number): void => {
        for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++)
                occupied.add(cellKey(x + dx, y + dy));
    };
    return buttons.map((b) => {
        if (hasPosition(b)) {
            const c = cells(b);
            claim(c.x, c.y, c.w, c.h);
            return { ...b };
        }
        const c = firstFreeSlot(
            occupied,
            DECK_CELL_DEFAULT.w,
            DECK_CELL_DEFAULT.h,
        );
        claim(c.x, c.y, c.w, c.h);
        return { ...b, x: c.x, y: c.y, w: c.w, h: c.h };
    });
}

/** The name of the widget's single (hidden) config field. */
export const DECK_FIELD = "buttons";

export const DECK_WIDGET_TYPE = "buttons";
// Grid units are 60 px rows on a 12-column grid: 4×4 fits two rows of keys.
export const DECK_DEFAULT_SIZE = { w: 4, h: 4 } as const;
export const DECK_MIN_SIZE = { w: 2, h: 2 } as const;
export const DECK_MAX_SIZE = { w: 12, h: 8 } as const;
export const DECK_MAX = 32;

const BUTTON_FIELDS = new Set([
    "deviceId",
    "actionId",
    "labelOverride",
    "iconOverride",
    "paramsOverride",
    "x",
    "y",
    "w",
    "h",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse the stored `buttons` config field. An empty string is an empty
 * layout; anything else must be a JSON array of well-formed entries. Throws
 * an Error naming the problem (the server turns it into a 400).
 */
export function parseButtons(raw: string | undefined): ButtonConfig[] {
    const text = (raw ?? "").trim();
    if (text === "") return [];
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("buttons must be a JSON array");
    }
    if (!Array.isArray(value)) throw new Error("buttons must be a JSON array");
    if (value.length > DECK_MAX)
        throw new Error(`buttons: at most ${DECK_MAX} buttons`);
    return value.map((item, i) => {
        if (
            !isRecord(item) ||
            typeof item.deviceId !== "string" ||
            !item.deviceId
        )
            throw new Error(`buttons[${i}]: deviceId is required`);
        if (typeof item.actionId !== "string" || !item.actionId)
            throw new Error(`buttons[${i}]: actionId is required`);
        const out: ButtonConfig = {
            deviceId: item.deviceId,
            actionId: item.actionId,
        };
        for (const key of ["labelOverride", "iconOverride"] as const) {
            const v = item[key];
            if (v === undefined || v === "") continue;
            if (typeof v !== "string")
                throw new Error(`buttons[${i}]: ${key} must be a string`);
            out[key] = v;
        }
        if (item.paramsOverride !== undefined) {
            if (!isRecord(item.paramsOverride))
                throw new Error(
                    `buttons[${i}]: paramsOverride must be an object`,
                );
            if (Object.keys(item.paramsOverride).length > 0)
                out.paramsOverride = item.paramsOverride;
        }
        // Position in the internal grid: optional (legacy layouts have none —
        // the frontend fills the first free slots), but when present it must be
        // four sane grid coordinates. Absent fields are omitted from the output.
        if (
            item.x !== undefined ||
            item.y !== undefined ||
            item.w !== undefined ||
            item.h !== undefined
        ) {
            if (!isCount(item.x, 0) || !isCount(item.y, 0))
                throw new Error(
                    `buttons[${i}]: position must be a non-negative integer`,
                );
            if (
                !isCount(item.w, 1) ||
                !isCount(item.h, 1) ||
                item.x + item.w > DECK_GRID_COLUMNS
            )
                throw new Error(
                    `buttons[${i}]: size must fit the ${DECK_GRID_COLUMNS}-column grid`,
                );
            out.x = item.x;
            out.y = item.y;
            out.w = item.w;
            out.h = item.h;
        }
        for (const key of Object.keys(item))
            if (!BUTTON_FIELDS.has(key))
                throw new Error(`buttons[${i}]: unknown field ${key}`);
        return out;
    });
}

export const serializeButtons = (buttons: readonly ButtonConfig[]): string =>
    buttons.length ? JSON.stringify(buttons) : "";

/** The params a press sends: the action's defaults under the button's override. */
export const mergedParams = (
    action: DashboardActionEntry,
    button: ButtonConfig,
): Record<string, unknown> => ({
    ...(action.params ?? {}),
    ...(button.paramsOverride ?? {}),
});

/** The devices a layout refers to (each once). */
export const buttonDevices = (buttons: readonly ButtonConfig[]): string[] => [
    ...new Set(buttons.map((b) => b.deviceId)),
];

/** Buttons whose action is missing from their device's catalogue (module
 * disabled / removed). A device without a known catalogue is skipped. */
export const orphanedButtons = (
    buttons: readonly ButtonConfig[],
    catalogue: (
        deviceId: string,
    ) => readonly DashboardActionEntry[] | undefined,
): ButtonConfig[] =>
    buttons.filter((b) => {
        const actions = catalogue(b.deviceId);
        return (
            actions !== undefined && !actions.some((a) => a.key === b.actionId)
        );
    });
