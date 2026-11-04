/** @jsx m */
/*
 * The `html_template` overlay element: renders a first-party HTML/CSS
 * template in-page via m.trust() — no iframe.
 *
 * The in-page markup is a string assembled from first-party parts only:
 * the template's self-contained index.html (its <section> body; its
 * <style> scoped into a one-per-template <style> in document.head — the
 * selector prefixing is the isolation boundary the iframe used to
 * provide), and the resolved
 * element config, which is entity-escaped before it is baked into the
 * markup (CSS variables, data-bind text slots, data-asset srcs).
 * escapeHtml/escapeAttr in render_doc.ts are the only dynamic splices.
 *
 * The in-frame document ships no <script>: the trusted fragment is inert
 * HTML, so the old bootstrap's countdown is carried by a module-scope 1s
 * tick that repaints the live [data-countdown] node of every registered
 * wrapper (DOM writes mithril never diffs).
 *
 * The string is the element's "raster": it is cached in a module-scope LRU
 * keyed by (templateId, resolved config). A redraw with an unchanged
 * key returns the identical string, so mithril's string diff leaves the
 * DOM untouched and CSS animations keep running; a config edit rewrites
 * the subtree and restarts them (the same trade the iframe reload made).
 *
 * Display tokens ({name}) in title/subtitle resolve HERE, in the
 * element's context, via the shared templateText (the alert element's
 * tokenizer); the runtime page writes trigger payload values into the
 * project variables before drawing, so a plain variable lookup covers
 * both. doc.ts never sees tokens — it stays environment-free.
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { libraryAssetField } from "@ui/overlay/asset_picker";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { bindField } from "@ui/overlay/fields";
import { templateText } from "@ui/overlay/template_tokens";
import type { Vnode, VnodeDOM } from "mithril";
import m from "mithril";
import { loadTemplateCatalog, loadTemplateDoc } from "./catalog";
import { buildTemplateConfig } from "./doc";
import type { HtmlTemplateProps } from "./overlay_schema";
import { DEFAULT_HTML_TEMPLATE_PROPS } from "./overlay_schema";
import { readColorAlpha, writeColorAlpha } from "./templates/color_value";
import { scopeTemplateCss } from "./templates/css_scope";
import {
	renderTemplateDoc,
	templateWrapperClass,
} from "./templates/render_doc";
import {
	parseRootVars,
	type RootVar,
	rootVarLabel,
} from "./templates/root_vars";
import type { ParsedTemplateDoc } from "./templates/template_doc";
import { isTextSlot, type TemplateMeta } from "./templates/template_meta";

// ── in-page style injection ──────────────────────────────────────────────
// One <style> per template id, scoped to that template's wrapper class. It
// is refcounted over the live hosts that use the template: created when the
// first such host paints, removed when the last one goes — so switching a
// template AWAY strips its <style> instead of piling stale rules into
// <head>. document is never touched at module scope (head exists only in
// the browser), so every call lives inside a draw lifecycle.

const styleEls = new Map<string, HTMLStyleElement>();
const styleRefs = new Map<string, number>();

// The doc bytes, memoized per template id for the life of the page. The
// runtime page mounts many elements (and a redraw re-fires `oncreate`), so
// each template is fetched once; concurrent duplicates await the same
// promise. The bytes come from the control server's `/overlay_templates`
// static route (read on the fly, not precompiled).
const docFiles = new Map<string, Promise<ParsedTemplateDoc>>();

function loadFiles(templateId: string): Promise<ParsedTemplateDoc> {
	let files = docFiles.get(templateId);
	if (!files) {
		files = loadTemplateDoc(templateId);
		docFiles.set(templateId, files);
	}
	return files;
}

// ── the runtime catalog (the picker's options) ───────────────────────────
// The edit form's template `<select>` offers the ids auto-discovered by
// the server's `/overlay_templates/_catalog.json` route. The same
// synchronous-render pattern as the vars fields: first paint is empty by
// design, the resolution's `m.redraw()` fills the options.
let catalogMetas: TemplateMeta[] | undefined;
let catalogLoading = false;

function loadCatalog(): void {
	if (catalogMetas !== undefined || catalogLoading) return;
	catalogLoading = true;
	void loadTemplateCatalog().then(
		(metas) => {
			catalogMetas = metas;
			catalogLoading = false;
			m.redraw();
		},
		(err: unknown) => {
			catalogLoading = false;
			console.warn("html_template: failed to load the template catalog", err);
		},
	);
}

// ── :root variables (the inspector's style knobs) ────────────────────────
// Each template's `:root` block declares its own custom properties; the
// edit form renders one field per entry and writes the overrides into
// `props.vars`. The bytes ride the same `loadFiles` memo as the render, so
// a template's css is fetched once per page; the RESOLVED list is kept in
// a second cache because the form is a synchronous render — the field
// component's `oncreate` kicks the fetch and the resolution's `m.redraw()`
// is what paints the fields (first paint is empty by design).

const rootVarsResolved = new Map<string, RootVar[]>();
const rootVarsPending = new Map<string, Promise<RootVar[]>>();

function loadRootVars(templateId: string): Promise<RootVar[]> {
	let p = rootVarsPending.get(templateId);
	if (!p) {
		p = loadFiles(templateId).then((f) => parseRootVars(f.css));
		rootVarsPending.set(templateId, p);
	}
	return p;
}

/**
 * Create (or refcount) the template's scoped <style>. A fresh host painting
 * the template calls this: the first one inserts the <style>, the rest just
 * raise the refcount. Idempotent per call (the host releases exactly once in
 * `onremove`, even if it was never painted).
 */
function acquireStyle(templateId: string, files: ParsedTemplateDoc): void {
	const refs = (styleRefs.get(templateId) ?? 0) + 1;
	styleRefs.set(templateId, refs);
	if (styleEls.get(templateId)) return;
	const style = document.createElement("style");
	// The scoper wants a full class *selector* (it requires a leading `.`,
	// matching the wrapper element's class); `templateWrapperClass` returns
	// the bare class name, so pass it dotted.
	style.textContent = scopeTemplateCss(
		files.css,
		`.${templateWrapperClass(templateId)}`,
	);
	document.head.appendChild(style);
	styleEls.set(templateId, style);
}

/**
 * Release one host's ref to the template's <style>; the last removal detaches
 * the element. Called from `onremove`, this is what lets a template that a
 * host switches away from shed its stale rules (a plain redraw re-acquires).
 */
function releaseStyle(templateId: string): void {
	const refs = styleRefs.get(templateId) ?? 0;
	if (refs <= 1) {
		styleRefs.delete(templateId);
		const style = styleEls.get(templateId);
		styleEls.delete(templateId);
		style?.remove();
		return;
	}
	styleRefs.set(templateId, refs - 1);
}

// ── countdown (replaces the in-frame bootstrap timer) ────────────────────
// One module-scope 1s interval for every live countdown element; the
// registry maps each wrapper element to its target epoch ms. The tick only
// writes textContent into the wrapper's [data-countdown] node — a DOM
// change mithril never diffs, so repaints survive innerHTML rewrites.

const countdowns = new Map<HTMLElement, number>();
let countdownTimer: ReturnType<typeof setInterval> | undefined;

function fmtCountdown(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function tickCountdowns(): void {
	const now = Date.now();
	for (const el of countdowns.keys()) {
		if (!el.isConnected) {
			countdowns.delete(el);
			continue;
		}
		const target = countdowns.get(el);
		const node = el.querySelector("[data-countdown]");
		if (target !== undefined && node)
			node.textContent = fmtCountdown(target - now);
	}
	if (countdowns.size === 0 && countdownTimer !== undefined) {
		clearInterval(countdownTimer);
		countdownTimer = undefined;
	}
}

function startCountdowns(): void {
	if (countdownTimer === undefined)
		countdownTimer = setInterval(tickCountdowns, 1000);
}

// ── doc cache ────────────────────────────────────────────────────────────
// Key = template id + the fully resolved config (tokens already
// interpolated). LRU: a hit
// re-inserts the entry so the least-recently-used one evicts; the cap
// keeps the cache bounded in long editor sessions.

const DOC_CACHE_CAP = 32;
const docCache = new Map<string, string>();

/** Everything the in-page doc depends on, in one stable-ordered object. */
interface DocInput {
	meta: TemplateMeta;
	/** The template body (the parsed `<section>` — no doc wrapper). */
	body: string;
	config: ReturnType<typeof buildTemplateConfig>;
}

function cachedDoc(input: DocInput): string {
	// The key omits `body` (large, and stable per template id within a page —
	// the bytes are fetched once and memoized), so a config change is what
	// busts the doc cache.
	const key = JSON.stringify({
		templateId: input.meta.id,
		config: input.config,
	});
	const hit = docCache.get(key);
	if (hit !== undefined) {
		docCache.delete(key);
		docCache.set(key, hit);
		return hit;
	}
	const doc = renderTemplateDoc({
		meta: input.meta,
		body: input.body,
		config: input.config,
	});
	docCache.set(key, doc);
	if (docCache.size > DOC_CACHE_CAP) {
		const oldest = docCache.keys().next().value;
		if (oldest !== undefined) docCache.delete(oldest);
	}
	return doc;
}

// ── render ───────────────────────────────────────────────────────────────

// Per-host paint state: the key of the last doc we wrote into the host's
// innerHTML. A redraw with an unchanged key is a no-op (memoized fetch +
// cached doc), so CSS animations and the live countdown keep running.
const paintState = new WeakMap<HTMLElement, string>();

/**
 * Resolve the template's text slots (its data-bind names) to concrete values:
 * each slot's prop value, with `{token}` tokens resolved against the
 * variables + an empty trigger payload. Only slots the template declares
 * (per meta.uses) are emitted, so the config carries exactly this template's
 * slots (title/subtitle plus any free-form slot like `label`).
 */
function resolveTextSlots(
	meta: TemplateMeta,
	props: HtmlTemplateProps,
	ctx: ElementContext,
): Record<string, string> {
	const text: Record<string, string> = {};
	for (const slot of meta.uses) {
		if (!isTextSlot(slot)) continue;
		text[slot] = templateText(
			String((props as unknown as Record<string, unknown>)[slot] ?? ""),
			ctx,
			{},
		);
	}
	return text;
}

/**
 * Populate a host element with its template doc, async. Fetches the template
 * bytes (memoized per template id), scopes + bakes the doc, injects the
 * one-per-template <style>, and writes the markup into the host. A redraw
 * with an unchanged key returns before touching the DOM, so an already-painted
 * host (with a running CSS animation / live countdown) is never re-rewritten.
 */
async function paintHost(
	host: HTMLElement,
	p: HtmlTemplateProps,
	ctx: ElementContext,
): Promise<void> {
	try {
		const files = await loadFiles(p.templateId);
		// The metadata (uses) is part of the fetched document, so the
		// config is built HERE, after the fetch — uses-gating needs the
		// parsed meta. Text slots (the template's data-bind names) are
		// resolved from the element's props + {token} tokens, so the config
		// carries exactly the slots THIS template binds (title/subtitle plus
		// any free-form slot like `label`).
		const text = resolveTextSlots(files.meta, p, ctx);
		const logo = p.logoAssetId ? ctx.assetUrls.get(p.logoAssetId) : undefined;
		const targetIso = typeof p.targetIso === "string" ? p.targetIso : undefined;
		const config = buildTemplateConfig({
			meta: files.meta,
			props: p as unknown as Record<string, unknown>,
			text,
			assets: { logo },
		});
		// Identity of everything the in-page doc depends on (the fetched
		// bytes are stable per template id within a page). A redraw with an
		// unchanged key is a no-op. The template fills the element's box,
		// so the box size itself is not part of the key — resizing never
		// repaints.
		const paintKey = JSON.stringify({
			templateId: p.templateId,
			config,
		});
		if (paintState.get(host) === paintKey) return;
		if (!host.isConnected) return;
		const doc = cachedDoc({
			meta: files.meta,
			body: files.body,
			config,
		});
		paintState.set(host, paintKey);
		acquireStyle(p.templateId, files);
		if (!host.isConnected) return;
		host.innerHTML = doc;
		// The [data-countdown] node only exists once the markup is in, so
		// the live countdown registers here (after the paint), not at
		// create time.
		if (config.countdown && targetIso && Date.parse(targetIso)) {
			countdowns.set(host, Date.parse(targetIso));
			if (countdowns.size > 0) startCountdowns();
		}
	} catch (err) {
		// A missing/broken template leaves the host empty — draw already
		// painted the unstyled shell, and the edit form's validator flags
		// the unknown id.
		console.warn(`html_template: failed to load template ${p.templateId}`, err);
	}
}

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer — props carry binding
	// values. The template's metadata (uses) rides the fetched document, so
	// the config is built in `paintHost` (post-fetch); draw just hands the
	// props + context over and the text slots get resolved there.
	const p = element.props as unknown as HtmlTemplateProps;

	return m(
		"div.ov-tpl-host",
		{
			style: {
				width: "100%",
				height: "100%",
				display: "block",
				overflow: "hidden",
				pointerEvents: "none",
			},
			// Keyed by template so Mithril remounts (not patches) the subtree
			// when a different template is selected: the fresh node's
			// `oncreate` fetches that template's <style> + doc and paints it,
			// and `onremove` unregisters the old node's countdown. Without
			// the key the node persists and switching templates left the new
			// one unstyled until a page refresh.
			key: p.templateId,
			oncreate: (vnode: VnodeDOM) => {
				void paintHost(vnode.dom as HTMLElement, p, ctx);
			},
			onupdate: (vnode: VnodeDOM) => {
				// A config edit re-runs the paint (the key is recomputed
				// post-fetch; an unchanged key is a no-op).
				void paintHost(vnode.dom as HTMLElement, p, ctx);
			},
			onremove: (vnode: VnodeDOM) => {
				countdowns.delete(vnode.dom as HTMLElement);
				paintState.delete(vnode.dom as HTMLElement);
				// Shed this host's ref to the template's <style>; the last
				// removal detaches it, so switching away strips the stale
				// rules (the new template's host re-acquires its own).
				releaseStyle(p.templateId);
			},
		},
		// No children: the host's markup is owned by paintHost (innerHTML),
		// not Mithril, so a diff never rewrites it and animations survive.
	) as Vnode;
}

// ── edit form ────────────────────────────────────────────────────────────

function propControl(
	propKey: string,
	p: HtmlTemplateProps,
	mutate: ElementProps["mutate"],
): Vnode {
	const set = (v: unknown) =>
		mutate((el) => {
			el.props[propKey] = v;
		});
	// Text slots (the template's data-bind names — title/subtitle plus any
	// free-form slot like `label`) are plain text fields; the value carries
	// the {token} template. Style knobs render via varsFields instead.
	if (isTextSlot(propKey)) {
		return (
			<input
				type="text"
				value={String((p as unknown as Record<string, unknown>)[propKey] ?? "")}
				oninput={(ev: Event) => set((ev.target as HTMLInputElement).value)}
			/>
		);
	}
	return <></>;
}

const PROP_LABELS: Record<string, string> = {
	title: "overlay.html_template.title",
	subtitle: "overlay.html_template.subtitle",
};

/** Human label for a free-form text slot: cap the words (`label` → `Label`,
 * `station_name` → `Station Name`). title/subtitle keep their i18n keys via
 * PROP_LABELS; every other data-bind slot is labelled from its name so no
 * i18n entry is needed for a template's bespoke slot. */
function textSlotLabel(slot: string): string {
	return slot
		.replace(/[_-]+/g, " ")
		.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** One inspector field for a single `:root` custom property. Control shape
 * follows the fallback's: 6-digit hex → color picker, a colour WITH alpha
 * (rgba/hsla/#rrggbbaa) → color picker + alpha slider (the native picker
 * has no alpha channel; writeColorAlpha keeps the `:root` fallback's
 * shape so the reset-drops-override contract holds), bare number /
 * `Npx`/`Nem`/… → number input (the unit is kept), anything else (font
 * stacks, …) → text. The value is the element's `vars` override, falling
 * back to the `:root` default; editing a field BACK to the default drops
 * the override (lean props, stable doc, cache-friendly). */
function varField(
	name: string,
	fallback: string,
	p: HtmlTemplateProps,
	mutate: ElementProps["mutate"],
): Vnode {
	const value = p.vars?.[name] ?? fallback;
	const set = (v: string): void =>
		mutate((el) => {
			const vars: Record<string, string> = { ...(el.props.vars ?? {}) };
			if (v === fallback) delete vars[name];
			else vars[name] = v;
			el.props.vars = vars;
		});
	let control: Vnode;
	if (/^#[0-9a-f]{6}$/i.test(fallback)) {
		control = (
			<input
				type="color"
				value={/^#[0-9a-f]{6}$/i.test(value) ? value : fallback}
				oninput={(ev: Event) => set((ev.target as HTMLInputElement).value)}
			/>
		);
	} else {
		// colour WITH alpha → picker + alpha slider (rgba/hsla/#rrggbbaa)
		const alphaFb = readColorAlpha(fallback);
		if (alphaFb !== null) {
			const ca = readColorAlpha(value) ?? alphaFb;
			control = (
				<span class="ov-colora">
					<input
						class="ov-colora-c"
						type="color"
						value={ca.hex}
						oninput={(ev: Event) =>
							set(
								writeColorAlpha(
									(ev.target as HTMLInputElement).value,
									ca.alpha,
								),
							)
						}
					/>
					<input
						class="ov-colora-a"
						type="range"
						min={0}
						max={1}
						step={0.01}
						value={ca.alpha}
						oninput={(ev: Event) =>
							set(
								writeColorAlpha(
									ca.hex,
									Number((ev.target as HTMLInputElement).value),
								),
							)
						}
					/>
				</span>
			);
		} else {
			const num = /^-?\d+(?:\.\d+)?(px|em|rem|%|s)?$/.exec(fallback);
			if (num) {
				const unit = num[1] ?? "";
				const n = (raw: string) => {
					const v = Number(raw);
					set(`${Number.isFinite(v) ? v : 0}${unit}`);
				};
				control = (
					<span class="ov-num">
						<input
							type="number"
							step="any"
							value={parseFloat(value)}
							oninput={(ev: Event) => n((ev.target as HTMLInputElement).value)}
						/>
						{unit !== "" && <span class="ov-num-unit">{unit}</span>}
					</span>
				);
			} else {
				control = (
					<input
						type="text"
						value={value}
						oninput={(ev: Event) => set((ev.target as HTMLInputElement).value)}
					/>
				);
			}
		}
	}
	return (
		<div class="ov-field">
			<span class="ov-lbl">{rootVarLabel(name)}</span>
			{control}
		</div>
	);
}

/** The template's `:root` variables as inspector fields (one per declared
 * custom property). Empty until the css bytes arrive — `oncreate` kicks the
 * memoized fetch and the resolution's `m.redraw()` paints the fields. */
function varsFields(
	templateId: string,
	p: HtmlTemplateProps,
	mutate: ElementProps["mutate"],
): Vnode {
	const vars = rootVarsResolved.get(templateId);
	return m(
		"div",
		{
			oncreate: () => {
				loadRootVars(templateId).then((list) => {
					rootVarsResolved.set(templateId, list);
					m.redraw();
				});
			},
		},
		(vars ?? []).map(([name, fallback]) => varField(name, fallback, p, mutate)),
	);
}

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props as unknown as HtmlTemplateProps;
	const sp = { mutate, variables };
	// The template's metadata rides the fetched catalog (_catalog.json +
	// the documents). Synchronous-render pattern, like the vars fields: the
	// fields are empty until the catalog resolves (the select's oncreate
	// kicks the fetch; its m.redraw paints the options + fields).
	const template = catalogMetas?.find((m) => m.id === p.templateId);
	const catalogMissing = catalogMetas !== undefined && template === undefined;

	const body = template ? (
		template.uses.map((propKey) => {
			// the style knobs: one field per `:root` variable the template
			// declares (rendered inline, at the "vars" position)
			if (propKey === "vars") return varsFields(template.id, p, mutate);
			if (propKey === "logoAssetId")
				return libraryAssetField(e, mutate, "image");
			if (propKey === "mode")
				return bindField(
					e,
					"props.mode",
					t("overlay.html_template.mode"),
					<select
						value={p.mode ?? "static"}
						onchange={(ev: Event) =>
							mutate((el) => {
								el.props.mode = (ev.target as HTMLSelectElement).value;
							})
						}
					>
						<option value="static">
							{t("overlay.html_template.mode_static")}
						</option>
						<option value="countdown">
							{t("overlay.html_template.mode_countdown")}
						</option>
					</select>,
					sp,
				);
			if (propKey === "targetIso")
				return bindField(
					e,
					"props.targetIso",
					t("overlay.html_template.target"),
					<input
						type="datetime-local"
						value={(p.targetIso ?? "").slice(0, 16)}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.targetIso = (ev.target as HTMLInputElement).value;
							})
						}
					/>,
					sp,
				);
			// Text slots: title/subtitle keep their i18n labels, any other
			// data-bind slot is labelled from its name (no i18n entry needed).
			return bindField(
				e,
				`props.${propKey}`,
				PROP_LABELS[propKey] ? t(PROP_LABELS[propKey]) : textSlotLabel(propKey),
				propControl(propKey, p, mutate),
				sp,
			);
		})
	) : catalogMissing ? (
		<span class="ov-lbl">{t("overlay.html_template.unknown_template")}</span>
	) : // catalog not loaded yet — the fields appear on the m.redraw
	null;

	return (
		<>
			{bindField(
				e,
				"props.templateId",
				t("overlay.html_template.template"),
				<select
					value={p.templateId}
					oncreate={loadCatalog}
					onchange={(ev: Event) =>
						mutate((el) => {
							el.props.templateId = (ev.target as HTMLSelectElement).value;
						})
					}
				>
					{(catalogMetas ?? []).map((tpl) => (
						<option key={tpl.id} value={tpl.id}>
							{t(tpl.name)}
						</option>
					))}
				</select>,
				sp,
			)}
			{body}
		</>
	);
}

// ── validate ─────────────────────────────────────────────────────────────

function validate(element: OverlayElement): string[] {
	const problems: string[] = [];
	const p = element.props as unknown as HtmlTemplateProps;
	// Synchronous validator — only check against the catalog once it has
	// loaded (an id outside it is a breach the runtime can never render).
	if (
		catalogMetas !== undefined &&
		!catalogMetas.some((m) => m.id === p.templateId)
	)
		problems.push(`unknown template: ${p.templateId}`);
	if (p.mode === "countdown" && !(p.targetIso && Date.parse(p.targetIso)))
		problems.push("countdown target is not a valid date");
	return problems;
}

// ── the element ──────────────────────────────────────────────────────────

export const htmlTemplateElement: OverlayElementDef = {
	type: "html_template",
	labelKey: "overlay.add_html_template",
	icon: () => <Icon name="iframe" class="role-icon" />,
	order: 75,
	defaultProps: { ...DEFAULT_HTML_TEMPLATE_PROPS },
	propKeys: [
		"templateId",
		"title",
		"subtitle",
		"accentColor",
		"bgColor",
		"textColor",
		"bgAlpha",
		"fontFamily",
		"fontSize",
		"padding",
		"radius",
		"logoAssetId",
		"mode",
		"targetIso",
	],
	defaultSize: { width: 960, height: 240 },
	draw,
	editForm,
	validate,
	handles: "box",
};
