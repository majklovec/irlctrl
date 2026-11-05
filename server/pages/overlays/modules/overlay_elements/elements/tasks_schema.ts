/*
 * Tasks element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * tasks.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { textRows } from "./schema_utils";

/* ── tasks ────────────────────────────────────────────────────────────── */
export interface TasksProps {
    title: string;
    entries: Array<{ label: string; done: boolean }>;
    color: string;
    accent: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_TASKS_PROPS: Required<TasksProps> = {
    title: "Today's goals",
    entries: [{ label: "Reach 1000 viewers", done: false }],
    color: "#ffffff",
    accent: "#22c55e",
    background: "#111827",
    radius: 10,
    fontSize: 22,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const tasksSchema: OverlayElementSchema = {
    type: "tasks",
    defaultProps: DEFAULT_TASKS_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_TASKS_PROPS;
        return {
            title: read.str("title", d.title, 120),
            entries: textRows(props.entries, 24, {
                key: "done",
                kind: "bool",
            }).map((r) => ({ label: String(r.label), done: r.done === true })),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
