/*
 * Countdown element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * countdown.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/* ── countdown ────────────────────────────────────────────────────────── */
export interface CountdownProps {
    /** The trigger event that (re)starts the countdown (duration mode). */
    event: string;
    /** `duration` = count down a fixed time; `clock` = count to a clock time. */
    mode: "duration" | "clock";
    /** Remaining/total time in seconds (duration mode). */
    duration: number;
    /** 24h `HH:MM` target (clock mode). */
    clockTarget: string;
    label: string;
    labelDone: string;
    /** Restart automatically when it reaches zero. */
    loop: boolean;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_COUNTDOWN_PROPS: Required<CountdownProps> = {
    event: "countdown",
    mode: "duration",
    duration: 60,
    clockTarget: "20:00",
    label: "Starting in",
    labelDone: "Start now!",
    loop: false,
    color: "#ffffff",
    background: "#111827",
    accent: "#f59e0b",
    radius: 12,
    fontSize: 40,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const countdownSchema: OverlayElementSchema = {
    type: "countdown",
    defaultProps: DEFAULT_COUNTDOWN_PROPS,
    normalizeProps(_p, read) {
        const d = DEFAULT_COUNTDOWN_PROPS;
        return {
            event: read.str("event", d.event, 100),
            mode: read.oneOf("mode", ["duration", "clock"], d.mode),
            duration: read.num("duration", d.duration, 1, 100000),
            clockTarget: read.str("clockTarget", d.clockTarget, 8),
            label: read.str("label", d.label, 120),
            labelDone: read.str("labelDone", d.labelDone, 120),
            loop: read.bool("loop"),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
