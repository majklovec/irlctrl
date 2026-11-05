/** @jsx m */
/*
 * Countdown widget — counts down a fixed duration, or to a daily clock time.
 * `clock` mode: pure function of the wall clock (today's `HH:MM`, rolling to
 * the next day when it has passed). `duration` mode: counts from `duration`
 * anchored at first draw (a loop re-anchors at each zero crossing). The inner
 * component owns a 1 s interval, cleared on removal.
 *
 * Like the `spin_wheel` it is trigger-driven and `persistent`: the element
 * stays on screen at runtime and (re)starts its duration countdown when its
 * trigger event fires — `GET /overlay/<overlay id>/event/<event>` writes a
 * fresh start time that the box picks up on its next draw.
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { numProp, strProp } from "@ui/overlay/element";
import { bindField } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import { formatDuration } from "../lib/ticker";
import { DEFAULT_COUNTDOWN_PROPS } from "../overlay_schema";

/** Today's `HH:MM` (tomorrow's when it has already passed). */
function targetTime(clockTarget: string, now: number): number {
	const [hh, mm] = clockTarget.split(":").map((v) => Number(v) || 0);
	const d = new Date(now);
	d.setHours(hh, mm, 0, 0);
	let target = d.getTime();
	if (target <= now) target += 24 * 3600 * 1000;
	return target;
}

interface CdB {
	props: Record<string, unknown>;
	/** Element id — keys the imperative start time written by `onTrigger`. */
	id: string;
}

interface CdBState {
	/** duration-mode anchor: the wall time the current cycle started at. */
	anchor: number;
	now: number;
	timer: ReturnType<typeof setInterval>;
}

/** Imperative per-element start times, written by `onTrigger`, read (and
 * cleared) by the box on its next draw so a trigger (re)starts the countdown
 * from a fixed wall-clock instant. */
const countdownStarts = new Map<string, number>();

/** The inspector's copy-link green flash (module scope: a `view`-local
 * boolean would reset on every redraw). */
let eventLinkCopied = false;

const CountdownBox: m.Component<CdB, CdBState> = {
	oncreate(vnode) {
		const now = Date.now();
		vnode.state.anchor = now;
		vnode.state.now = now;
		vnode.state.timer = setInterval(() => {
			vnode.state.now = Date.now();
			m.redraw();
		}, 1000);
	},
	onremove(vnode) {
		clearInterval(vnode.state.timer);
	},
	view(vnode) {
		const p = vnode.attrs.props;
		const s = vnode.state;
		// A trigger fired since the last draw: re-anchor to that wall-clock
		// instant so the duration countdown (re)starts from a fixed point.
		const startAt = countdownStarts.get(vnode.attrs.id);
		if (startAt !== undefined) {
			countdownStarts.delete(vnode.attrs.id);
			s.anchor = startAt;
		}
		const now = s.now;
		const mode = strProp(p, "mode", "duration");
		const duration = numProp(p, "duration", 60);
		const clockTarget = strProp(p, "clockTarget", "20:00");
		const label = strProp(p, "label", "Starting in");
		const labelDone = strProp(p, "labelDone", "Start now!");
		const loop = p.loop === true;
		const color = strProp(p, "color", "#ffffff");
		const bg = strProp(p, "background", "#111827");
		const accent = strProp(p, "accent", "#f59e0b");
		const radius = numProp(p, "radius", 12);
		const fontSize = numProp(p, "fontSize", 40);
		const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
		const periodMs = duration * 1000;

		let rem: number;
		let done: boolean;
		if (mode === "clock") {
			rem = targetTime(clockTarget, now) - now;
			done = rem <= 0;
		} else {
			// A looping duration countdown re-anchors at each zero crossing so
			// it keeps running in whole cycles.
			if (loop && now - s.anchor >= periodMs)
				s.anchor += Math.ceil((now - s.anchor) / periodMs) * periodMs;
			rem = s.anchor + periodMs - now;
			done = rem <= 0;
		}
		const shown =
			done && !(mode === "duration" && loop) ? "00:00" : formatDuration(rem);

		return (
			<div
				style={{
					width: "100%",
					height: "100%",
					boxSizing: "border-box",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					gap: `${Math.round(fontSize * 0.2)}px`,
					background: bg,
					border: `2px solid ${accent}`,
					borderRadius: `${radius}px`,
					color,
					fontFamily,
					padding: `${fontSize * 0.3}px`,
				}}
			>
				<div
					style={{
						fontSize: `${Math.round(fontSize * 0.5)}px`,
						opacity: "0.85",
						textTransform: "uppercase",
						letterSpacing: "0.08em",
					}}
				>
					{done ? labelDone : label}
				</div>
				<div
					style={{
						fontSize: `${fontSize}px`,
						fontWeight: "700",
						fontVariantNumeric: "tabular-nums",
					}}
				>
					{shown}
				</div>
			</div>
		);
	},
};

function draw(element: OverlayElement, _ctx: ElementContext): Vnode<any, any> {
	return m(CountdownBox, { props: element.props, id: element.id });
}

/** Trigger handler (same universal event channel as `spin_wheel`): when the
 * event name matches `props.event`, record a fresh start time (duration
 * mode) — the box re-anchors to it on its next draw, (re)starting the
 * countdown. Persistent, so it returns `undefined` (no display duration). */
function onTrigger(
	element: OverlayElement,
	eventName: string,
	_payload: Record<string, unknown>,
	_ctx: ElementContext,
): number | undefined {
	if (eventName !== strProp(element.props, "event", "countdown"))
		return undefined;
	countdownStarts.set(element.id, Date.now());
	m.redraw();
	return undefined;
}

function editForm({
	element: e,
	mutate,
	variables,
	eventUrl,
}: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	const eventName = strProp(p, "event", "countdown");
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	const setSel = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLSelectElement).value;
		});
	const setBool = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).checked;
		});
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	return (
		<>
			{bindField(
				e,
				"props.event",
				t("overlay.cd_event"),
				<input
					type="text"
					value={eventName}
					oninput={setStr("event")}
				/>,
				sp,
			)}
			{eventUrl ? (
				<button
					class={
						eventLinkCopied ? "ov-var-copy ov-copied" : "ov-var-copy"
					}
					type="button"
					style={{ marginTop: "2px" }}
					title={
						eventLinkCopied
							? t("overlay.copied")
							: eventUrl(eventName) + " — " + t("overlay.cd_event_link")
					}
					aria-label={t("overlay.cd_event_link")}
					onclick={() => {
						void navigator.clipboard.writeText(eventUrl(eventName)).then(
							() => {
								eventLinkCopied = true;
								m.redraw();
								setTimeout(() => {
									eventLinkCopied = false;
									m.redraw();
								}, 1500);
							},
						);
					}}
				>
					<Icon name="copy" class="role-icon" />
				</button>
			) : null}
			{bindField(
				e,
				"props.mode",
				t("overlay.cd_mode"),
				<select
					value={strProp(p, "mode", "duration")}
					onchange={setSel("mode")}
				>
					<option value="duration">{t("overlay.cd_mode.duration")}</option>
					<option value="clock">{t("overlay.cd_mode.clock")}</option>
				</select>,
				sp,
			)}
			{strProp(p, "mode", "duration") === "duration"
				? bindField(
						e,
						"props.duration",
						t("overlay.cd_duration"),
						<input
							type="number"
							min={1}
							max={100000}
							value={numProp(p, "duration", 60)}
							oninput={setNum("duration")}
						/>,
						sp,
					)
				: bindField(
						e,
						"props.clockTarget",
						t("overlay.cd_target"),
						<input
							type="time"
							value={strProp(p, "clockTarget", "20:00")}
							oninput={setStr("clockTarget")}
						/>,
						sp,
					)}
			<div class="ov-grid2">
				{bindField(
					e,
					"props.label",
					t("overlay.cd_label"),
					<input
						type="text"
						value={strProp(p, "label", "Starting in")}
						oninput={setStr("label")}
					/>,
					sp,
				)}
				{bindField(
					e,
					"props.labelDone",
					t("overlay.cd_label_done"),
					<input
						type="text"
						value={strProp(p, "labelDone", "Start now!")}
						oninput={setStr("labelDone")}
					/>,
					sp,
				)}
			</div>
			{bindField(
				e,
				"props.loop",
				t("overlay.cd_loop"),
				<input
					type="checkbox"
					checked={p.loop === true}
					onchange={setBool("loop")}
				/>,
				sp,
			)}
			<div class="ov-grid3">
				{bindField(
					e,
					"props.color",
					t("overlay.color"),
					<input
						type="color"
						value={strProp(p, "color", "#ffffff")}
						oninput={setStr("color")}
					/>,
					sp,
				)}
				{bindField(
					e,
					"props.background",
					t("overlay.cd_background"),
					<input
						type="color"
						value={strProp(p, "background", "#111827")}
						oninput={setStr("background")}
					/>,
					sp,
				)}
				{bindField(
					e,
					"props.accent",
					t("overlay.cd_accent"),
					<input
						type="color"
						value={strProp(p, "accent", "#f59e0b")}
						oninput={setStr("accent")}
					/>,
					sp,
				)}
			</div>
			{bindField(
				e,
				"props.fontSize",
				t("overlay.font_size"),
				<input
					type="number"
					min={8}
					max={300}
					value={numProp(p, "fontSize", 40)}
					oninput={setNum("fontSize")}
				/>,
				sp,
			)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.event !== "string" || e.props.event === "")
		problems.push("event must be a non-empty string");
	const ct = strProp(e.props, "clockTarget", "");
	if (
		strProp(e.props, "mode", "duration") === "clock" &&
		!/^\d{1,2}:\d{2}$/.test(ct)
	)
		problems.push('clockTarget must be "HH:MM"');
	return problems;
}

export const countdownElement: OverlayElementDef = {
	type: "countdown",
	labelKey: "overlay.add_countdown",
	icon: () => <Icon name="clock" class="role-icon" />,
	order: 92,
	defaultProps: { ...DEFAULT_COUNTDOWN_PROPS },
	propKeys: [
		"event",
		"mode",
		"duration",
		"clockTarget",
		"label",
		"labelDone",
		"loop",
		"color",
		"background",
		"accent",
		"fontSize",
	],
	defaultSize: { width: 300, height: 140 },
	draw,
	editForm,
	validate,
	handles: "box",
	/** On screen at runtime; a trigger event (re)starts the countdown. */
	persistent: true,
	onTrigger,
};
