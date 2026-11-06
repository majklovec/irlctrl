/** @jsx m */
/*
 * Alert element — a trigger-driven overlay (TODO.md "Alert element").
 * It fires for a named event: `GET /overlay/<overlay id>/event/<name>` shows this alert
 * while `<name>` equals `props.event`, rendering a media + template-text
 * composition with intro/outro animations, an optional audio sting and TTS,
 * for `duration` ms. Consecutive triggers on the same element queue FIFO;
 * the trigger's `<name>=<value>` pairs are written to the project
 * variables when this alert plays (queued alerts hold their values until
 * their turn), and the written values persist (the runtime never clears
 * them).
 *
 * Template tokens `{name}` resolve against a project variable of that name
 * first, then against a key of the trigger payload (the event endpoint's
 * `?<name>=<value>` pairs); token segments render in the accent colour.
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { numProp, strProp, triggerPhase } from "@ui/overlay/element";
import { bindableForm } from "@ui/overlay/fields";
import { libraryAssetField } from "@ui/overlay/asset_picker";
import type { Vnode } from "mithril";
import m from "mithril";

interface AlertUiProps {
	event: string;
	duration: number;
	layoutType: "stack" | "row" | "overlay";
	assetType: "image" | "video";
	mediaAssetId: string;
	videoVolume: number;
	audioAssetId: string;
	audioVolume: number;
	titleTemplate: string;
	messageTemplate: string;
	fontFamily: string;
	fontSize: number;
	fontWeight: number;
	fontColor: string;
	accentColor: string;
	introAnimation: string;
	outroAnimation: string;
	textAnimation: string;
	isVariation: boolean;
	conditionType: "exact" | "min";
	conditionValue: number;
	ttsEnabled: boolean;
	ttsVoice: string;
	ttsVolume: number;
	ttsMinAmount: number;
}

function alertProps(p: Record<string, unknown>): AlertUiProps {
	const d = DEFAULT_ALERT_PROPS;
	const layout = p.layoutType;
	const asset = p.assetType;
	const cond = p.conditionType;
	return {
		event: strProp(p, "event", d.event),
		duration: numProp(p, "duration", d.duration),
		layoutType: layout === "row" || layout === "overlay" ? layout : "stack",
		assetType: asset === "video" ? "video" : "image",
		mediaAssetId: strProp(p, "mediaAssetId", d.mediaAssetId),
		videoVolume: numProp(p, "videoVolume", d.videoVolume),
		audioAssetId: strProp(p, "audioAssetId", d.audioAssetId),
		audioVolume: numProp(p, "audioVolume", d.audioVolume),
		titleTemplate: strProp(p, "titleTemplate", d.titleTemplate),
		messageTemplate: strProp(p, "messageTemplate", d.messageTemplate),
		fontFamily: strProp(p, "fontFamily", d.fontFamily),
		fontSize: numProp(p, "fontSize", d.fontSize),
		fontWeight: numProp(p, "fontWeight", d.fontWeight),
		fontColor: strProp(p, "fontColor", d.fontColor),
		accentColor: strProp(p, "accentColor", d.accentColor),
		introAnimation: strProp(p, "introAnimation", d.introAnimation),
		outroAnimation: strProp(p, "outroAnimation", d.outroAnimation),
		textAnimation: strProp(p, "textAnimation", d.textAnimation),
		isVariation: p.isVariation === true,
		conditionType: cond === "exact" ? "exact" : "min",
		conditionValue: numProp(p, "conditionValue", d.conditionValue),
		ttsEnabled: p.ttsEnabled === true,
		ttsVoice: strProp(p, "ttsVoice", d.ttsVoice),
		ttsVolume: numProp(p, "ttsVolume", d.ttsVolume),
		ttsMinAmount: numProp(p, "ttsMinAmount", d.ttsMinAmount),
	};
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

// OBS browser sources load without a user gesture, so Chrome silently ignores
// speechSynthesis.speak() until the engine is "unlocked" by a one-off silent
// utterance. We do that once per page load, on the first TTS trigger.
let ttsUnlocked = false;
/** Unlock Web Speech for gesture-less contexts. @returns true when it just
 * unlocked (the caller should skip `speechSynthesis.cancel()` so the silent
 * utterance is not killed before it registers). */
function unlockTts(): boolean {
	if (ttsUnlocked) return false;
	if (typeof window === "undefined" || !("speechSynthesis" in window))
		return false;
	window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
	ttsUnlocked = true;
	return true;
}

// ── template parser ──────────────────────────────────────────────────────
// Lives in the overlay_templates module (shared with the html_template
// element); re-exported here so existing importers keep working.
import {
	parseTemplate,
	templateText,
	tokenValue,
} from "@ui/overlay/template_tokens";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/** Alert element: fires for the named event `props.event` (published by
 * `GET /overlay/<overlay id>/event/<name>`), shows media + token text for `duration` ms,
 * then fades out (TODO.md "Alert element"). Consecutive triggers on the
 * same element queue FIFO; the trigger's `<name>=<value>` pairs ride with
 * the alert and are written to the project variables when the alert
 * plays (a queued alert's values never clobber the on-air ones early). */
export const ALERT_INTRO_ANIMATIONS = [
	"none",
	"fadeIn",
	"slideDown",
	"slideUp",
	"slideLeft",
	"slideRight",
	"zoomIn",
	"bounceIn",
] as const;

export const ALERT_OUTRO_ANIMATIONS = [
	"none",
	"fadeOut",
	"zoomOut",
	"slideDown",
	"slideUp",
] as const;

export const ALERT_TEXT_ANIMATIONS = [
	"none",
	"fadeIn",
	"typewriter",
	"pop",
] as const;

export interface AlertProps {
	/** trigger event name the alert listens for */
	event: string;
	/** how long the alert stays on screen, ms */
	duration: number;
	/** stack = media above text, row = media left of text, overlay = text over media */
	layoutType: "stack" | "row" | "overlay";
	assetType: "image" | "video";
	/** main media (image/* or video/* asset) */
	mediaAssetId: string;
	/** 0–1, the video's own audio track */
	videoVolume: number;
	/** separate sting (audio/* asset) played on trigger */
	audioAssetId: string;
	/** 0–1 */
	audioVolume: number;
	/** `{token}` templates; tokens resolve by variable name, then payload key */
	titleTemplate: string;
	messageTemplate: string;
	fontFamily: string;
	fontSize: number;
	fontWeight: number;
	fontColor: string;
	/** colour of the dynamic tokens only */
	accentColor: string;
	introAnimation: string;
	outroAnimation: string;
	textAnimation: string;
	/** variation: fires only when its condition on `amount` holds */
	isVariation: boolean;
	conditionType: "exact" | "min";
	conditionValue: number;
	ttsEnabled: boolean;
	/** speech-synthesis voice name; "" = the engine default */
	ttsVoice: string;
	/** 0–1 */
	ttsVolume: number;
	/** TTS is allowed only when the event's amount reaches this */
	ttsMinAmount: number;
}

export const DEFAULT_ALERT_PROPS: Required<AlertProps> = {
	event: "twitch.follow",
	duration: 5000,
	layoutType: "stack",
	assetType: "image",
	mediaAssetId: "",
	videoVolume: 1,
	audioAssetId: "",
	audioVolume: 1,
	titleTemplate: "Hello {name}!",
	messageTemplate: "{message}",
	fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
	fontSize: 28,
	fontWeight: 700,
	fontColor: "#ffffff",
	accentColor: "#ffd700",
	introAnimation: "slideDown",
	outroAnimation: "fadeOut",
	textAnimation: "none",
	isVariation: false,
	conditionType: "min",
	conditionValue: 0,
	ttsEnabled: false,
	ttsVoice: "",
	ttsVolume: 1,
	ttsMinAmount: 0,
};
export {
	parseTemplate,
	tokenValue,
	templateText,
	type TemplateSegment,
} from "@ui/overlay/template_tokens";

function renderTemplate(
	template: string,
	ctx: ElementContext,
	payload: Record<string, unknown>,
	accentColor: string,
): m.Children {
	return parseTemplate(template).map((seg, i) =>
		seg.token
			? m(
					"span",
					{ key: i, style: { color: accentColor } },
					tokenValue(seg.text, ctx, payload),
				)
			: m("span", { key: i }, seg.text),
	);
}

/** The `amount` an amount-based rule compares: a variable named `amount`
 * first, then the payload's `amount`. */
function amountOf(
	ctx: ElementContext,
	payload: Record<string, unknown>,
): number | undefined {
	const n = Number(ctx.variableNames.get("amount") ?? payload["amount"]);
	return Number.isFinite(n) ? n : undefined;
}

// ── draw ─────────────────────────────────────────────────────────────────

function mediaNode(
	p: AlertUiProps,
	ctx: ElementContext,
	element: OverlayElement,
): Vnode | null {
	const url = p.mediaAssetId ? ctx.assetUrls.get(p.mediaAssetId) : undefined;
	if (!url) return null;
	if (p.assetType === "video")
		return m("video.overlay-alert-media", {
			src: url,
			playsInline: true,
			oncreate: (vnode) => {
				// The runtime page only draws ACTIVE alerts, so node
				// creation is the moment to start playback; the editor's
				// design state stays paused and silent.
				if (ctx.activeTriggers !== undefined) {
					const video = (vnode as unknown as { dom?: Element })
						.dom as HTMLVideoElement;
					video.volume = clamp01(p.videoVolume);
					void video.play().catch(() => {});
				}
			},
		});
	return m("img.overlay-alert-media", {
		src: url,
		alt: element.name,
		draggable: false,
	});
}

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer — props carry binding values.
	const p = alertProps(element.props);
	const active = ctx.activeTriggers?.get(element.id);
	const phase = triggerPhase(active, Date.now());
	const payload = active?.payload ?? {};

	const rootClasses = [
		"overlay-alert",
		`overlay-alert-${p.layoutType}`,
		phase === "in" && p.introAnimation !== "none"
			? `alert-intro-${p.introAnimation}`
			: "",
		phase === "out" && p.outroAnimation !== "none"
			? `alert-outro-${p.outroAnimation}`
			: "",
	]
		.filter(Boolean)
		.join(" ");

	const media = mediaNode(p, ctx, element);
	const text = (
		<div
			class={
				"overlay-alert-text" +
				(p.textAnimation !== "none" ? ` alert-text-${p.textAnimation}` : "")
			}
			style={{
				fontFamily: p.fontFamily,
				fontWeight: `${p.fontWeight}`,
				color: p.fontColor,
			}}
		>
			<div
				class="overlay-alert-title"
				style={{ fontSize: `${p.fontSize}px`, lineHeight: 1.2 }}
			>
				{renderTemplate(p.titleTemplate, ctx, payload, p.accentColor)}
			</div>
			<div
				class="overlay-alert-message"
				style={{
					fontSize: `${Math.max(8, Math.round(p.fontSize * 0.7))}px`,
					lineHeight: 1.3,
				}}
			>
				{renderTemplate(p.messageTemplate, ctx, payload, p.accentColor)}
			</div>
		</div>
	);
	// layout is purely CSS (.overlay-alert-{stack,row,overlay}); in `overlay`
	// the text sits over the media via position:relative/z-index
	return m("div", { class: rootClasses }, [media, text]);
}

// ── trigger (runtime) ────────────────────────────────────────────────────

function onTrigger(
	element: OverlayElement,
	eventName: string,
	payload: Record<string, unknown>,
	ctx: ElementContext,
): number | undefined {
	const p = alertProps(element.props);
	if (eventName !== p.event) return undefined;

	if (p.isVariation) {
		const amount = amountOf(ctx, payload);
		if (amount === undefined) return undefined;
		const passes =
			p.conditionType === "exact"
				? amount === p.conditionValue
				: amount >= p.conditionValue;
		if (!passes) return undefined;
	}

	// Audio sting (the video's own track starts with its <video> node).
	if (p.audioAssetId) {
		const url = ctx.assetUrls.get(p.audioAssetId);
		if (url) {
			const audio = new Audio(url);
			audio.volume = clamp01(p.audioVolume);
			void audio.play().catch(() => {});
		}
	}

	// TTS (Web Speech): allowed only once the event's amount reaches the
	// anti-spam threshold; a missing amount counts as 0.
	if (
		p.ttsEnabled &&
		typeof window !== "undefined" &&
		"speechSynthesis" in window
	) {
		const amount = amountOf(ctx, payload) ?? 0;
		if (amount >= p.ttsMinAmount) {
			const sentence = [
				templateText(p.titleTemplate, ctx, payload),
				"... : ...",
				templateText(p.messageTemplate, ctx, payload),
			]
				.filter(Boolean)
				.join(" ")
				.trim();
			if (sentence) {
				const justUnlocked = unlockTts();
				const utterance = new SpeechSynthesisUtterance(sentence);
				utterance.volume = clamp01(p.ttsVolume);
				const voice = window.speechSynthesis
					.getVoices()
					.find((v) => v.name === p.ttsVoice || v.voiceURI === p.ttsVoice);
				if (voice) utterance.voice = voice;
				// fast triggers: replace, don't queue — but a cancel() right
				// after unlock would kill the silent unlock utterance
				if (!justUnlocked) window.speechSynthesis.cancel();
				window.speechSynthesis.speak(utterance);
			}
		}
	}

	return p.duration;
}

// ── inspector ────────────────────────────────────────────────────────────

function editForm({
	element: e,
	mutate,
	variables,
	variableUrl,
}: ElementProps): Vnode {
	const p = e.props;
	const set = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement | HTMLSelectElement).value;
		});

	return (
		<div
			oncreate={() => {
				// speech-synthesis voices load async; redraw when they arrive
				if (typeof window !== "undefined" && "speechSynthesis" in window)
					window.speechSynthesis.onvoiceschanged = () => m.redraw();
			}}
		>
			{bindableForm({
				element: e,
				mutate,
				variables,
				variableUrl,
				rows: [
					// 1. structure & trigger
					[
						{
							path: "props.event",
							labelKey: "overlay.alert_event",
							type: "text",
							value: strProp(p, "event", ""),
						},
					],
					[
						{
							path: "props.duration",
							labelKey: "overlay.alert_duration",
							type: "number",
							value: numProp(p, "duration", 5000),
							min: 500,
							max: 60000,
							step: 100,
						},
						{
							path: "props.layoutType",
							labelKey: "overlay.alert_layout",
							type: "select",
							value: strProp(p, "layoutType", "stack"),
							options: [
								{ value: "stack", label: "stack" },
								{ value: "row", label: "row" },
								{ value: "overlay", label: "overlay" },
							],
						},
					],
					// 2. media
					[
						{
							path: "props.assetType",
							labelKey: "overlay.alert_media_type",
							type: "select",
							value: strProp(p, "assetType", "image"),
							options: [
								{ value: "image", label: "image" },
								{ value: "video", label: "video" },
							],
						},
					],
					libraryAssetField(
						e,
						mutate,
						strProp(p, "assetType", "image") === "video"
							? "video"
							: "image",
						"mediaAssetId",
					),
					[
						{
							path: "props.videoVolume",
							labelKey: "overlay.alert_video_volume",
							type: "number",
							value: numProp(p, "videoVolume", 1),
							min: 0,
							max: 1,
							step: 0.05,
						},
					],
					// 3. audio sting
					libraryAssetField(e, mutate, "audio", "audioAssetId"),
					[
						{
							path: "props.audioVolume",
							labelKey: "overlay.alert_audio_volume",
							type: "number",
							value: numProp(p, "audioVolume", 1),
							min: 0,
							max: 1,
							step: 0.05,
						},
					],
					// 4. text
					[
						{
							path: "props.titleTemplate",
							labelKey: "overlay.ft_title",
							type: "text",
							value: strProp(p, "titleTemplate", "Hello {name}!"),
						},
					],
					[
						{
							path: "props.messageTemplate",
							labelKey: "overlay.alert_message",
							type: "text",
							value: strProp(p, "messageTemplate", "{message}"),
						},
					],
					[
						{
							path: "props.fontFamily",
							labelKey: "overlay.alert_font_family",
							type: "text",
							value: strProp(p, "fontFamily", "system-ui, sans-serif"),
						},
					],
					[
						{
							path: "props.fontSize",
							labelKey: "overlay.alert_font_size",
							type: "number",
							value: numProp(p, "fontSize", 28),
							min: 8,
							max: 400,
						},
						{
							path: "props.fontWeight",
							labelKey: "overlay.font_weight",
							type: "number",
							value: numProp(p, "fontWeight", 700),
							min: 100,
							max: 900,
							step: 100,
						},
					],
					[
						{
							path: "props.fontColor",
							labelKey: "overlay.alert_font_color",
							type: "color",
							value: strProp(p, "fontColor", "#ffffff"),
						},
						{
							path: "props.accentColor",
							labelKey: "overlay.alert_accent_color",
							type: "color",
							value: strProp(p, "accentColor", "#ffd700"),
						},
					],
					// 5. animations
					[
						{
							path: "props.introAnimation",
							labelKey: "overlay.alert_intro_animation",
							type: "select",
							value: strProp(p, "introAnimation", "slideDown"),
							options: ALERT_INTRO_ANIMATIONS.map((name) => ({
								value: name,
								label: name,
							})),
						},
						{
							path: "props.outroAnimation",
							labelKey: "overlay.alert_outro_animation",
							type: "select",
							value: strProp(p, "outroAnimation", "fadeOut"),
							options: ALERT_OUTRO_ANIMATIONS.map((name) => ({
								value: name,
								label: name,
							})),
						},
					],
					[
						{
							path: "props.textAnimation",
							labelKey: "overlay.alert_text_animation",
							type: "select",
							value: strProp(p, "textAnimation", "none"),
							options: ALERT_TEXT_ANIMATIONS.map((name) => ({
								value: name,
								label: name,
							})),
						},
					],
					// 6. variation
					[
						{
							path: "props.isVariation",
							labelKey: "overlay.alert_variation",
							type: "checkbox",
							value: p.isVariation === true,
						},
						{
							path: "props.conditionType",
							labelKey: "overlay.alert_condition",
							type: "select",
							value: strProp(p, "conditionType", "min"),
							options: [
								{ value: "exact", label: "exact" },
								{ value: "min", label: "min" },
							],
						},
						{
							path: "props.conditionValue",
							labelKey: "overlay.alert_condition_value",
							type: "number",
							value: numProp(p, "conditionValue", 0),
							min: 0,
						},
					],
					// 7. TTS
					[
						{
							path: "props.ttsEnabled",
							labelKey: "overlay.alert_tts",
							type: "checkbox",
							value: p.ttsEnabled === true,
						},
					],
					// the voice list builds from the async `speechSynthesis.getVoices()`
					// (loaded by the oncreate hook above), so it stays a raw widget —
					// it can't be expressed as a static descriptor `options`
					<div class="ov-field">
						<span class="ov-lbl">{t("overlay.alert_tts_voice")}</span>
						<select
							value={strProp(p, "ttsVoice", "")}
							onchange={set("ttsVoice")}
						>
							<option value="">
								{t("overlay.alert_tts_default_voice")}
							</option>
							{typeof window !== "undefined" && "speechSynthesis" in window
								? window.speechSynthesis.getVoices().map((v) => (
										<option value={v.name}>
											{v.name} ({v.lang})
										</option>
									))
								: []}
						</select>
					</div>,
					[
						{
							path: "props.ttsVolume",
							labelKey: "overlay.alert_tts_volume",
							type: "number",
							value: numProp(p, "ttsVolume", 1),
							min: 0,
							max: 1,
							step: 0.05,
						},
					],
					[
						{
							path: "props.ttsMinAmount",
							labelKey: "overlay.alert_tts_min_amount",
							type: "number",
							value: numProp(p, "ttsMinAmount", 0),
							min: 0,
						},
					],
				],
			})}
		</div>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.event !== "string" || e.props.event.length === 0)
		problems.push("alert has no event");
	const p = alertProps(e.props);
	if (
		typeof e.props.duration === "number" &&
		(p.duration < 500 || p.duration > 60000)
	)
		problems.push("alert duration out of range (500–60000 ms)");
	if (p.videoVolume < 0 || p.videoVolume > 1)
		problems.push("video volume must be in 0–1");
	if (p.audioVolume < 0 || p.audioVolume > 1)
		problems.push("audio volume must be in 0–1");
	if (p.conditionValue < 0) problems.push("condition value must be >= 0");
	if (p.ttsVolume < 0 || p.ttsVolume > 1)
		problems.push("TTS volume must be in 0–1");
	if (p.ttsMinAmount < 0) problems.push("TTS minimum amount must be >= 0");
	return problems;
}

export const alertsElement: OverlayElementDef & OverlayElementSchema = {
	type: "alert",
	category: "widgets",

	labelKey: "overlay.add_alert",
	icon: () => <Icon name="bell" class="role-icon" />,
	order: 70,
	defaultProps: { ...DEFAULT_ALERT_PROPS },
	propKeys: [
		"event",
		"duration",
		"layoutType",
		"assetType",
		"mediaAssetId",
		"videoVolume",
		"audioAssetId",
		"audioVolume",
		"titleTemplate",
		"messageTemplate",
		"fontFamily",
		"fontSize",
		"fontWeight",
		"fontColor",
		"accentColor",
		"introAnimation",
		"outroAnimation",
		"textAnimation",
		"isVariation",
		"conditionType",
		"conditionValue",
		"ttsEnabled",
		"ttsVoice",
		"ttsVolume",
		"ttsMinAmount",
	],
	defaultSize: { width: 420, height: 160 },
	draw,
	editForm,
	validate,
	handles: "box",
	onTrigger,
	serverAssetProps: ["mediaAssetId", "audioAssetId"],
	normalizeProps(_props, read) {
		const d = DEFAULT_ALERT_PROPS;
		return {
			event: read.str("event", d.event, 100),
			duration: read.num("duration", d.duration, 500, 60000),
			layoutType: read.oneOf(
				"layoutType",
				["stack", "row", "overlay"],
				d.layoutType,
			),
			assetType: read.oneOf("assetType", ["image", "video"], d.assetType),
			mediaAssetId: read.str("mediaAssetId", ""),
			videoVolume: read.num("videoVolume", d.videoVolume, 0, 1),
			audioAssetId: read.str("audioAssetId", ""),
			audioVolume: read.num("audioVolume", d.audioVolume, 0, 1),
			titleTemplate: read.str("titleTemplate", d.titleTemplate, 500),
			messageTemplate: read.str(
				"messageTemplate",
				d.messageTemplate,
				2000,
			),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
			fontSize: read.num("fontSize", d.fontSize, 8, 400),
			fontWeight: read.num("fontWeight", d.fontWeight, 100, 900),
			fontColor: read.hex("fontColor", d.fontColor),
			accentColor: read.hex("accentColor", d.accentColor),
			introAnimation: read.oneOf(
				"introAnimation",
				ALERT_INTRO_ANIMATIONS,
				d.introAnimation,
			),
			outroAnimation: read.oneOf(
				"outroAnimation",
				ALERT_OUTRO_ANIMATIONS,
				d.outroAnimation,
			),
			textAnimation: read.oneOf(
				"textAnimation",
				ALERT_TEXT_ANIMATIONS,
				d.textAnimation,
			),
			isVariation: read.bool("isVariation"),
			conditionType: read.oneOf(
				"conditionType",
				["exact", "min"],
				d.conditionType,
			),
			conditionValue: read.num(
				"conditionValue",
				d.conditionValue,
				0,
				1e12,
			),
			ttsEnabled: read.bool("ttsEnabled"),
			ttsVoice: read.str("ttsVoice", "", 200),
			ttsVolume: read.num("ttsVolume", d.ttsVolume, 0, 1),
			ttsMinAmount: read.num("ttsMinAmount", d.ttsMinAmount, 0, 1e12),
		};
	},
};
