/** @jsx m */
/*
 * Spin-wheel widget — a prize wheel that spins when its trigger event fires
 * (the same universal event channel as the `alert` element:
 * `GET /overlay/<overlay id>/event/<event>` hits `onTrigger`, which picks a prize and
 * returns the spin duration in ms).
 * Like `alert` it is trigger-driven, but `persistent`: the wheel stays on
 * screen at all times at runtime (it only reacts to triggers) instead of
 * existing only while a trigger is active.
 *
 * Look: a gold rim (the `accent` colour) around a `conic-gradient` disc
 * segmented per prize (bright palette, cycled), cream spokes and rim studs
 * on the segment boundaries, a black centre hub with a gold cap, and a dark
 * red pointer on top. The winning segment is the one under the top pointer
 * when the CSS rotation transition lands. In the editor it renders its
 * design state (stopped, no prize).
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type { MithrilJSXComponent } from "@ui/jsx";
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

/** Landing rotation: 4 full turns AHEAD of the current rotation (always
 * forward) so that `offset` (0–360, the resting rotation under the top
 * pointer) ends up where the transition stops. */
function accumulateSpin(current: number, offset: number): number {
	const base = ((current % 360) + 360) % 360;
	const delta = ((offset - base) % 360 + 360) % 360;
	return base + 360 * 4 + delta;
}

/** Bright per-segment palette, cycled when the prize list is longer. */
const SEGMENT_PALETTE = [
	"#ffc400",
	"#f4511e",
	"#8b5cf6",
	"#00bfa5",
	"#ef4444",
	"#3b82f6",
	"#22c55e",
	"#ec4899",
];
/** Spokes and rim studs. */
const CREAM = "#f8f1de";

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
			// Accumulate full turns from the CURRENT rotation so repeated
			// spins (the wheel is persistent, so it spins many times on air)
			// always turn forward and stop exactly on the winner.
			s.rotation = accumulateSpin(s.rotation, pending.offset);
			s.winner = pending.winner;
			spinTargets.delete(vnode.attrs.id);
		}
		const rawPrizes = Array.isArray(p.prizes) ? p.prizes : [];
		const prizes = rawPrizes
			.map((v) => (typeof v === "string" ? v : ""))
			.filter((v) => v !== "");
		const duration = numProp(p, "duration", 4000);
		const color = strProp(p, "color", "#ffffff");
		const accent = strProp(p, "accent", "#f59e0b");
		const radius = numProp(p, "radius", 0);
		const fontSize = numProp(p, "fontSize", 16);
		const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");

		const n = Math.max(prizes.length, 2);
		const seg = 360 / n;

		// The conic-gradient: one bright palette colour per prize segment
		// (starts at 12 o'clock, clockwise — the same geometry the labels
		// and spokes use).
		const stops: string[] = [];
		for (let i = 0; i < n; i++) {
			const tone = SEGMENT_PALETTE[i % SEGMENT_PALETTE.length];
			stops.push(`${tone} ${i * seg}deg ${(i + 1) * seg}deg`);
		}

		// Segment-center angle, deg clockwise from the top. Each label sits
		// in the middle of its OWN segment, running along the radius with
		// the text pointing INWARD (toward the hub); spokes and rim studs
		// sit on the segment BOUNDARIES (`i * seg`).
		const midOf = (i: number) => i * seg + seg / 2;

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
					/* no background — the wheel sits directly on the stream */
					background: "transparent",
					borderRadius: `${radius}px`,
					overflow: "hidden",
					color,
					fontFamily,
				}}
			>
				{/* wheel assembly (1:1; its own size container so all inner
				 * geometry can use cqi = the wheel's diameter) */}
				<div
					style={{
						position: "relative",
						width: "min(100%, 100cqh)",
						aspectRatio: "1",
						containerType: "size",
					}}
				>
					{/* gold rim + drop shadow under the wheel */}
					<div
						style={{
							position: "absolute",
							inset: 0,
							borderRadius: "50%",
							background: accent,
							boxShadow:
								"0 calc(100cqi * 0.035) calc(100cqi * 0.09) rgba(0,0,0,0.45)",
						}}
					/>
					{/* rotating disc: palette segments, thin black ring,
					 * spokes + rim studs on the boundaries and the labels —
					 * all of it rotates together */}
					<div
						style={{
							position: "absolute",
							inset: "calc(100cqi * 0.05)",
							boxSizing: "border-box",
							borderRadius: "50%",
							border: "calc(100cqi * 0.016) solid #17181c",
							background: `conic-gradient(${stops.join(", ")})`,
							transform: `rotate(${s.rotation}deg)`,
							transition:
								s.rotation > 0
									? `transform ${duration}ms cubic-bezier(0.2, 0.7, 0.3, 1)`
									: "none",
						}}
					>
						{Array.from({ length: n }, (_, i) => (
							<div
								key={`spoke-${i}`}
								style={{
									position: "absolute",
									left: "50%",
									top: "0",
									width: "calc(100cqi * 0.012)",
									height: "50%",
									marginLeft: "calc(100cqi * -0.006)",
									background: CREAM,
									transform: `rotate(${i * seg}deg)`,
									transformOrigin: "50% 100%",
								}}
							/>
						))}
						{Array.from({ length: n }, (_, i) => (
							<div
								key={`stud-${i}`}
								style={{
									position: "absolute",
									left: "50%",
									top: "50%",
									width: "calc(100cqi * 0.03)",
									height: "calc(100cqi * 0.03)",
									marginLeft: "calc(100cqi * -0.015)",
									marginTop: "calc(100cqi * -0.015)",
									borderRadius: "50%",
									background: CREAM,
									// circle: rotating about its own centre is a
									// no-op, so this lands the stud on the rim
									// at the boundary angle
									transform: `rotate(${i * seg}deg) translateY(calc(100cqi * -0.47))`,
								}}
							/>
						))}
						{prizes.map((prize, i) =>
							m(
								"div",
								{
									key: `label-${i}`,
									style: {
										position: "absolute",
										left: "50%",
										top: "50%",
										// transform-origin is the div's top-left, which
										// sits on the wheel centre: rotate to the
										// segment's centre angle, hop out along that
										// radius, then rotate the TEXT 90° so it runs
										// along the radius pointing at the wheel
										// centre, and centre it on the spoke point.
										transformOrigin: "0 0",
										transform: `rotate(${midOf(i)}deg) translateY(calc(100cqi * -0.33)) rotate(90deg) translate(-50%, -50%)`,
										fontSize: `${fontSize}px`,
										fontWeight: "800",
										whiteSpace: "nowrap",
										textShadow: "0 1px 2px rgba(0,0,0,0.65)",
									},
								},
								prize,
							),
						)}
					</div>
					{/* centre hub: black disc, accent ring, accent cap */}
					<div
						style={{
							position: "absolute",
							left: "50%",
							top: "50%",
							transform: "translate(-50%, -50%)",
							width: "calc(100cqi * 0.2)",
							height: "calc(100cqi * 0.2)",
							borderRadius: "50%",
							background: "#14161a",
							border: `calc(100cqi * 0.016) solid ${accent}`,
							boxShadow: "0 2px 8px rgba(0,0,0,0.55)",
							zIndex: 2,
						}}
					>
						<div
							style={{
								position: "absolute",
								inset: "34%",
								borderRadius: "50%",
								background: accent,
							}}
						/>
					</div>
					{/* top pointer: dark red, always over the wheel (top: 0 —
					 * it must not overflow the element box, which clips) */}
					<div
						style={{
							position: "absolute",
							top: "calc(100cqi * 0.02)",
							left: "50%",
							transform: "translateX(-50%)",
							width: 0,
							height: 0,
							borderLeft: "calc(100cqi * 0.04) solid transparent",
							borderRight: "calc(100cqi * 0.04) solid transparent",
							borderTop: "calc(100cqi * 0.06) solid #b91c1c",
							filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.4))",
							zIndex: 3,
						}}
					/>
				</div>
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
 * `onTrigger` only records the RESTING rotation (the 0–360 offset that puts
 * the winner's center under the top pointer) into `spinTargets`; the box
 * adds the full turns at draw time, so every spin turns forward from
 * wherever the previous spin stopped. */
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
	// Resting rotation that puts `winner`'s center under the top pointer:
	// pointer at 270deg; segment center at
	// (rotation + winner*seg + seg/2) mod 360 == 270 → rotation = 270 - winner*seg - seg/2.
	const offset = (270 - winner * seg - seg / 2) % 360;

	spinTargets.set(element.id, { offset, winner });
	m.redraw();
	return duration;
}

/** Imperative spin state per element, written by `onTrigger`, read (and
 * cleared) by the box on its next draw so the CSS transition animates to the
 * new rotation. `offset` is the resting rotation (0–360). */
const spinTargets = new Map<string, { offset: number; winner: number }>();

/** The inspector's copy-link green flash (module scope: a `view`-local
 * boolean would reset on every redraw). */
let eventLinkCopied = false;

function editForm({
	element: e,
	mutate,
	variables,
	eventUrl,
}: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	const eventName = strProp(p, "event", "spin");
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
			{bindField(
				e,
				"props.event",
				t("overlay.sw_event"),
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
							: eventUrl(eventName) + " — " + t("overlay.sw_event_link")
					}
					aria-label={t("overlay.sw_event_link")}
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
				"props.duration",
				t("overlay.sw_duration"),
				<input
					type="number"
					min={500}
					max={60000}
					step={250}
					value={numProp(p, "duration", 4000)}
					oninput={setNum("duration")}
				/>,
				sp,
			)}
			<PrizesField element={e} mutate={mutate} />
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
					"props.accent",
					t("overlay.sw_accent"),
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
					max={200}
					value={numProp(p, "fontSize", 16)}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.fontSize = Number((ev.target as HTMLInputElement).value);
						})
					}
				/>,
				sp,
			)}
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
		const prizes = (
			Array.isArray(e.props.prizes) ? e.props.prizes : []
		) as string[];
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
											set(
												prizes.map((v, j) =>
													j === i ? (ev.target as HTMLInputElement).value : v,
												),
											)
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
} as unknown as MithrilJSXComponent<{
	element: OverlayElement;
	mutate: (fn: (el: OverlayElement) => void) => void;
}>;

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.event !== "string" || e.props.event === "")
		problems.push("event must be a non-empty string");
	const prizes = (
		Array.isArray(e.props.prizes) ? e.props.prizes : []
	) as string[];
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
	propKeys: ["event", "duration", "color", "accent", "fontSize"],
	defaultSize: { width: 340, height: 340 },
	draw,
	editForm,
	validate,
	handles: "box",
	/** Always on screen at runtime; it only reacts to its trigger event. */
	persistent: true,
	onTrigger,
};
