/** @jsx m */
/*
 * Spin-wheel widget — a prize wheel that spins when its trigger event fires
 * (the same alert channel as the `alert` element: `GET /overlay/alert/<event>`
 * hits `onTrigger`, which picks a prize and returns the spin duration in ms).
 * The wheel is a `conic-gradient` disc segmented per prize; the winning
 * segment is the one under the top pointer when the CSS rotation transition
 * lands. In the editor it renders its design state (stopped, no prize).
 */

import { Icon } from "@ui/components/icons";
import type { MithrilJSXComponent } from "@ui/jsx";
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
import { DEFAULT_SPIN_WHEEL_PROPS } from "../overlay_schema";

/** Deterministic-ish prize pick: uniform random over the prize list. */
function pickPrize(count: number): number {
	return Math.floor(Math.random() * count);
}

interface SpinState {
	/** The wheel's current rotation in degrees (0 = design state). */
	rotation: number;
	/** The prize index the current spin landed on (undefined until a spin). */
	winner: number | undefined;
}

interface SpinAttrs {
	props: Record<string, unknown>;
	/** Element id — keys the imperative spin state written by `onTrigger`. */
	id: string;
}

const SpinWheelBox: m.Component<SpinAttrs, SpinState> = {
	oncreate(vnode) {
		vnode.state.rotation = 0;
		vnode.state.winner = undefined;
	},
	view(vnode) {
		const p = vnode.attrs.props;
		const s = vnode.state;
		// Consume a spin target left by `onTrigger` (the runtime page
		// re-renders right after the trigger fires, so the box picks it up
		// on this draw and lets the CSS transition do the spinning).
		const pending = spinTargets.get(vnode.attrs.id);
		if (pending) {
			s.rotation = pending.rotation;
			s.winner = pending.winner;
			spinTargets.delete(vnode.attrs.id);
		}
		const rawPrizes = Array.isArray(p.prizes) ? p.prizes : [];
		const prizes = rawPrizes
			.map((v) => (typeof v === "string" ? v : ""))
			.filter((v) => v !== "");
		const duration = numProp(p, "duration", 4000);
		const color = strProp(p, "color", "#ffffff");
		const background = strProp(p, "background", "#111827");
		const accent = strProp(p, "accent", "#f59e0b");
		const radius = numProp(p, "radius", 0);
		const fontSize = numProp(p, "fontSize", 16);
		const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");

		const n = Math.max(prizes.length, 2);
		const seg = 360 / n;

		// Build the conic-gradient: alternating accent tints per segment.
		const stops: string[] = [];
		for (let i = 0; i < n; i++) {
			const tone = i % 2 === 0 ? accent : background;
			stops.push(`${tone} ${i * seg}deg ${(i + 1) * seg}deg`);
		}

		// The pointer sits at the top (-90deg / 270deg). A prize i is under
		// the pointer when (rotation + i*seg + seg/2) mod 360 == 270.
		const centerLabel =
			s.winner !== undefined && prizes[s.winner] !== undefined
				? prizes[s.winner]
				: "";

		return (
			<div
				style={{
					width: "100%",
					height: "100%",
					boxSizing: "border-box",
					position: "relative",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					background: background,
					borderRadius: `${radius}px`,
					overflow: "hidden",
					color,
					fontFamily,
				}}
			>
				<div
					style={{
						position: "relative",
						width: "min(100%, 100cqh)",
						aspectRatio: "1",
						borderRadius: "50%",
						border: `4px solid ${accent}`,
						boxShadow: `0 0 24px ${accent}55`,
					}}
				>
					{/* the rotating disc */}
					<div
						style={{
							position: "absolute",
							inset: 0,
							borderRadius: "50%",
							background: `conic-gradient(${stops.join(", ")})`,
							transform: `rotate(${s.rotation}deg)`,
							transition: s.rotation > 0
								? `transform ${duration}ms cubic-bezier(0.2, 0.7, 0.3, 1)`
								: "none",
						}}
					/>
					{prizes.map((prize, i) => (
						m(
							"div",
							{
								key: i,
								style: {
									position: "absolute",
									left: "50%",
									top: "50%",
									transform: `rotate(${i * seg + seg / 2}deg) translateY(-38%)`,
									transformOrigin: "0 0",
									fontSize: `${fontSize}px`,
									fontWeight: "700",
									whiteSpace: "nowrap",
									textShadow: "0 1px 2px rgba(0,0,0,0.7)",
								},
							},
							prize,
						)
					))}
					{/* center hub with the winner */}
					<div
						style={{
							position: "absolute",
							left: "50%",
							top: "50%",
							transform: "translate(-50%, -50%)",
							width: "42%",
							height: "42%",
							borderRadius: "50%",
							background: background,
							border: `3px solid ${accent}`,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							textAlign: "center",
							fontSize: `${Math.round(fontSize * 0.9)}px`,
							fontWeight: "700",
							padding: "6%",
							overflow: "hidden",
						}}
					>
						{centerLabel}
					</div>
				</div>
				{/* the top pointer */}
				<div
					style={{
						position: "absolute",
						top: "0",
						left: "50%",
						transform: "translateX(-50%)",
						width: 0,
						height: 0,
						borderLeft: "10px solid transparent",
						borderRight: "10px solid transparent",
						borderTop: `16px solid ${accent}`,
						zIndex: 2,
					}}
				/>
			</div>
		);
	},
};

function draw(element: OverlayElement, _ctx: ElementContext): Vnode<any, any> {
	return m(SpinWheelBox, { props: element.props, id: element.id });
}

/** Trigger handler: the runtime calls this for every alert event. When the
 * event matches `props.event`, pick a prize and return the spin duration
 * (ms) — the wheel component animates to the winner.
 *
 * The rotation target is computed so the winning segment's center lands under
 * the top pointer (270deg). We spin a few full turns plus the offset. */
function onTrigger(
	element: OverlayElement,
	eventName: string,
	_payload: Record<string, unknown>,
	_ctx: ElementContext,
): number | undefined {
	const p = element.props;
	if (eventName !== strProp(p, "event", "spin")) return undefined;
	const prizes = (Array.isArray(p.prizes) ? p.prizes : [])
		.map((v) => (typeof v === "string" ? v : ""))
		.filter((v) => v !== "");
	if (prizes.length === 0) return undefined;
	const duration = numProp(p, "duration", 4000);

	// Reach the wheel's component state through the render tree: the SpinWheelBox
	// owns `rotation`/`winner`. We set them imperatively via the element's
	// DOM node state is not reachable here, so instead we drive the animation
	// by mutating a module-scoped target the box reads on its next redraw.
	const n = prizes.length;
	const seg = 360 / n;
	const winner = pickPrize(n);
	// Target rotation: current full-turns + the offset that puts `winner`
	// center under the pointer. pointer at 270deg; segment center at
	// (rotation + winner*seg + seg/2) mod 360 == 270 → rotation = 270 - winner*seg - seg/2.
	const offset = (270 - winner * seg - seg / 2) % 360;
	const target = 360 * 4 + offset; // a few full turns + the landing offset

	spinTargets.set(element.id, { rotation: target, winner });
	m.redraw();
	return duration;
}

/** Imperative spin state per element, written by `onTrigger`, read (and
 * cleared) by the box on its next draw so the CSS transition animates to the
 * new rotation. */
const spinTargets = new Map<string, { rotation: number; winner: number }>();

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	return (
		<>
			{bindField(e, "props.event", t("overlay.sw_event"),
				<input type="text" value={strProp(p, "event", "spin")} oninput={setStr("event")} />, sp)}
			{bindField(e, "props.duration", t("overlay.sw_duration"),
				<input type="number" min={500} max={60000} step={250} value={numProp(p, "duration", 4000)} oninput={setNum("duration")} />, sp)}
			<PrizesField element={e} mutate={mutate} />
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.accent", t("overlay.sw_accent"),
					<input type="color" value={strProp(p, "accent", "#f59e0b")} oninput={setStr("accent")} />, sp)}
				{bindField(e, "props.background", t("overlay.sw_background"),
					<input type="color" value={strProp(p, "background", "#111827")} oninput={setStr("background")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 16)} oninput={(ev: Event) => mutate((el) => { el.props.fontSize = Number((ev.target as HTMLInputElement).value); })} />, sp)}
		</>
	);
}

/** The prize list editor (a string-array prop): one text input per prize +
 * add/remove. */
const PrizesField = {
	view: (vnode: m.Vnode): Vnode => {
		const { element: e, mutate } = vnode.attrs as {
			element: OverlayElement;
			mutate: (fn: (el: OverlayElement) => void) => void;
		};
	const prizes = (Array.isArray(e.props.prizes) ? e.props.prizes : []) as string[];
	const set = (next: string[]): void =>
		mutate((el) => {
			el.props.prizes = next;
		});
	return (
		<div class="ov-field">
			<span class="ov-lbl">{t("overlay.sw_prizes")}</span>
			<div class="ov-channels">
				{prizes.length === 0 ? (
					<div class="ov-channels-empty">{t("overlay.no_rows")}</div>
				) : (
					prizes.map((prize, i) => (
						<div class="ov-list-row" key={i}>
							<span class="ov-list-cell">
								<input
									value={prize}
									aria-label={t("overlay.sw_prize")}
									oninput={(ev: Event) =>
										set(prizes.map((v, j) => (j === i ? (ev.target as HTMLInputElement).value : v)))
									}
								/>
							</span>
							<button
								class="ov-channel-remove"
								type="button"
								aria-label={t("overlay.remove_row")}
								onclick={() => set(prizes.filter((_, j) => j !== i))}
							>
								<Icon name="close" class="role-icon" />
							</button>
						</div>
					))
				)}
				<button
					class="ov-channel-add"
					type="button"
					onclick={() => set([...prizes, ""])}
				>
					+ {t("overlay.sw_add_prize")}
				</button>
			</div>
		</div>
	);
	},
} as MithrilJSXComponent<{
	element: OverlayElement;
	mutate: (fn: (el: OverlayElement) => void) => void;
}>;

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.event !== "string" || e.props.event === "")
		problems.push("event must be a non-empty string");
	const prizes = (Array.isArray(e.props.prizes) ? e.props.prizes : []) as string[];
	if (prizes.filter((v) => typeof v === "string" && v !== "").length < 2)
		problems.push("at least 2 prizes are required");
	return problems;
}

export const spinWheelElement: OverlayElementDef = {
	type: "spin_wheel",
	labelKey: "overlay.add_spin_wheel",
	icon: () => <Icon name="spin" class="role-icon" />,
	order: 100,
	defaultProps: { ...DEFAULT_SPIN_WHEEL_PROPS },
	/** `prizes` is one composite control (a string list), not a bindField scalar. */
	propKeys: [
		"event",
		"duration",
		"color",
		"accent",
		"background",
		"fontSize",
	],
	defaultSize: { width: 340, height: 340 },
	draw,
	editForm,
	validate,
	handles: "box",
	onTrigger,
};
