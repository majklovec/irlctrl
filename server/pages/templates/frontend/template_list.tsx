/** @jsx m */
/* The templates editor: the overlay HTML templates (assets/overlay_templates)
 * as a two-pane page — the template list on the left, and for the selected
 * template an HTML editor, the :root CSS-variable knobs, the data-bind slot
 * fields and a live preview (an iframe fed with the document the runtime
 * would bake). Saving writes the file; the control server serves the same
 * directory, so the template is live for OBS with no reload.
 *
 * The HTML textarea is the source of truth: the variables and bindings
 * panels are editing sugar on it — a knob change rewrites the document
 * (the :root value / the slot's default text), and a document change
 * re-derives the knobs, keeping the values of the survivors.
 */

import { apiErrorMessage, apiJson } from "@ui/api_client";
import {
	Actions,
	Badge,
	Button,
	Card,
	confirmDialog,
	EmptyState,
	IconButton,
	Page,
	Toast,
	Toolbar,
	useToast,
} from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { i18nReady, t } from "@ui/i18n";
import type { MithrilJSXComponent } from "@ui/jsx";
import { mountPage } from "@ui/util";
import m from "mithril";
import { ServerNav } from "../../../shell/nav";
import { highlightHtml } from "./highlight";
import {
	buildPreviewDoc,
	defaultBind,
	describeDoc,
	escapeHtml,
	parseBinds,
	parseVars,
} from "./preview";

interface TemplateSummary {
	id: string;
	name: string;
	size: number;
	updatedAt: number;
	vars: [string, string][];
	binds: string[];
	valid: boolean;
	error?: string;
}

interface TemplateDetail extends TemplateSummary {
	html: string;
}

const toast = useToast();

const list = {
	items: null as TemplateSummary[] | null,
	loading: false,
};

const editor = {
	open: false,
	id: "",
	html: "",
	vars: {} as Record<string, string>,
	text: {} as Record<string, string>,
	valid: true,
	docError: undefined as string | undefined,
	dirty: false,
	saving: false,
	tab: "html" as "fields" | "html",
};

const createBox = { open: false, id: "" };

/** The preview frame's box: "fit" fills the pane at 16:9 (like the canvas);
 * unchecked, it renders at the author's w×h — the OBS element's size. */
const previewSize = { fit: true, w: 640, h: 360 };

let previewDoc = "";
let previewTimer: number | null = null;

/** Debounce the iframe rebuild: it reloads its document on every change. */
function schedulePreview(): void {
	if (previewTimer !== null) window.clearTimeout(previewTimer);
	previewTimer = window.setTimeout(() => {
		previewTimer = null;
		previewDoc = buildPreviewDoc({
			html: editor.html,
			vars: editor.vars,
			text: editor.text,
		});
		m.redraw();
	}, 250);
}

async function refreshList(): Promise<void> {
	list.loading = list.items === null;
	m.redraw();
	const body = await apiJson<{ templates: TemplateSummary[] }>(
		"/api/templates",
	).catch(() => null);
	list.loading = false;
	list.items = body?.templates ?? [];
	m.redraw();
}

/** Load one template into the editor from a fresh detail fetch. */
function loadDetail(detail: TemplateDetail): void {
	editor.open = true;
	editor.id = detail.id;
	editor.html = detail.html;
	editor.vars = Object.fromEntries(detail.vars);
	editor.text = {};
	for (const slot of detail.binds)
		editor.text[slot] = defaultBind(detail.html, slot);
	const doc = describeDoc(detail.html);
	editor.valid = doc.valid;
	editor.docError = doc.error;
	editor.dirty = false;
	editor.saving = false;
	editor.tab = "html";
	previewDoc = buildPreviewDoc({
		html: editor.html,
		vars: editor.vars,
		text: editor.text,
	});
}

async function select(id: string): Promise<void> {
	if (editor.open && editor.id !== id && editor.dirty) {
		const ok = await confirmDialog(t("tpl.discard_confirm"), {
			okLabel: t("tpl.discard"),
			danger: true,
		});
		if (!ok) return;
	}
	const body = await apiJson<{ template: TemplateDetail }>(
		`/api/templates/${encodeURIComponent(id)}`,
	).catch(() => null);
	if (body) {
		loadDetail(body.template);
		m.redraw();
	} else {
		toast.show(t("tpl.load_failed"), true);
	}
}

/** The textarea is the source of truth: re-derive the knobs, keeping the
 * current values of the vars/slots that survive the edit. */
function applyHtml(html: string): void {
	editor.html = html;
	const nextVars: Record<string, string> = {};
	for (const [name, value] of parseVars(html))
		nextVars[name] = editor.vars[name] ?? value;
	const nextText: Record<string, string> = {};
	for (const slot of parseBinds(html))
		nextText[slot] = editor.text[slot] ?? defaultBind(html, slot);
	editor.vars = nextVars;
	editor.text = nextText;
	const doc = describeDoc(html);
	editor.valid = doc.valid;
	editor.docError = doc.error;
	editor.dirty = true;
	schedulePreview();
	m.redraw();
}

/** Rewrite one `:root` entry's value in the document (append when the var
 * was just typed into the CSS). */
function setVar(name: string, value: string): void {
	editor.vars[name] = value;
	const rootMatch = /:root\s*\{([\s\S]*?)\}/.exec(editor.html);
	if (rootMatch) {
		const open = rootMatch.index + rootMatch[0].indexOf("{") + 1;
		const block = rootMatch[1];
		const declarations = block
			.split(";")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		const existing = declarations.findIndex((part) =>
			part.startsWith(`${name}:`),
		);
		const entry = value.length > 0 ? `${name}: ${value}` : "";
		if (existing >= 0) {
			declarations[existing] = entry;
		} else if (entry.length > 0) {
			declarations.push(entry);
		}
		const nextBlock = `${declarations
			.filter((part) => part.length > 0)
			.map((part) => `  ${part};`)
			.join("\n")}\n`;
		editor.html =
			editor.html.slice(0, open) +
			nextBlock +
			editor.html.slice(open + block.length);
		editor.dirty = true;
		schedulePreview();
		m.redraw();
	}
}

/** Rewrite the default text of every element bound to the slot. */
function setBind(slot: string, value: string): void {
	editor.text[slot] = value;
	const re = new RegExp(
		`(\\bdata-bind="${slot}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`,
		"g",
	);
	editor.html = editor.html.replace(re, `$1${escapeHtml(value)}$3`);
	editor.dirty = true;
	schedulePreview();
	m.redraw();
}

async function save(): Promise<void> {
	if (editor.saving || !editor.open) return;
	editor.saving = true;
	m.redraw();
	const body = await apiJson<{ template: TemplateDetail }>(
		`/api/templates/${encodeURIComponent(editor.id)}`,
		{ method: "PUT", body: { html: editor.html } },
	).catch((err: unknown) => {
		toast.show(apiErrorMessage(err), true);
		return null;
	});
	editor.saving = false;
	if (body) {
		loadDetail(body.template);
		editor.dirty = false;
		if (list.items) {
			let idx = list.items.findIndex((s) => s.id === body.template.id);
			if (idx === -1) {
				idx = list.items.length;
				list.items.push(body.template);
			} else {
				list.items[idx] = body.template;
			}
			list.items.sort((a, b) => a.id.localeCompare(b.id));
		}
		toast.show(t("tpl.saved"));
	}
	m.redraw();
}

async function startCreate(): Promise<void> {
	const id = createBox.id.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9_]*$/.test(id)) {
		toast.show(t("tpl.bad_id"), true);
		return;
	}
	const body = await apiJson<{ template: TemplateDetail }>("/api/templates", {
		method: "POST",
		body: { id },
	}).catch((err: unknown) => {
		toast.show(apiErrorMessage(err), true);
		return null;
	});
	if (body) {
		createBox.open = false;
		createBox.id = "";
		await refreshList();
		loadDetail(body.template);
		toast.show(t("tpl.created"));
		m.redraw();
	}
}

async function remove(): Promise<void> {
	if (!editor.open) return;
	const ok = await confirmDialog(t("tpl.delete_confirm", { id: editor.id }), {
		okLabel: t("tpl.delete"),
		danger: true,
	});
	if (!ok) return;
	const res = await apiJson(`/api/templates/${encodeURIComponent(editor.id)}`, {
		method: "DELETE",
	}).catch((err: unknown) => {
		toast.show(apiErrorMessage(err), true);
		return null;
	});
	if (res) {
		editor.open = false;
		editor.id = "";
		editor.dirty = false;
		previewDoc = "";
		await refreshList();
		toast.show(t("tpl.deleted"));
		m.redraw();
	}
}

/** The list pane: the templates with their contract status + the create row. */
function ListPane() {
	return (
		<Card
			class="tpl-list-card"
			title={t("mgmt.templates")}
			headActions={
				<Button
					label={t("tpl.new")}
					onclick={() => {
						createBox.open = !createBox.open;
						m.redraw();
					}}
				/>
			}
		>
			{createBox.open && (
				<form
					class="tpl-create"
					onsubmit={(e: Event) => {
						e.preventDefault();
						void startCreate();
					}}
				>
					<input
						class="tpl-create-input"
						placeholder={t("tpl.new_id")}
						value={createBox.id}
						oninput={(ev: Event) => {
							createBox.id = (ev.target as HTMLInputElement).value;
							m.redraw();
						}}
						onkeydown={(ev: KeyboardEvent) => {
							if (ev.key === "Escape") {
								createBox.open = false;
								createBox.id = "";
								m.redraw();
							}
						}}
						autofocus
					/>
					<Button type="submit" label={t("tpl.create")} />
				</form>
			)}
			{list.loading ? (
				<p class="muted">{t("mgmt.loading")}</p>
			) : list.items === null ? null : list.items.length === 0 ? (
				<EmptyState message={t("tpl.empty")} />
			) : (
				<div class="tpl-list">
					{list.items.map((item) => (
						<button
							key={item.id}
							type="button"
							class={
								editor.id === item.id ? "tpl-list-row active" : "tpl-list-row"
							}
							aria-pressed={editor.id === item.id}
							onclick={() => {
								void select(item.id);
							}}
						>
							<span class="tpl-list-id">{item.id}</span>
							{item.valid ? null : <Badge text={t("tpl.invalid")} kind="off" />}
						</button>
					))}
				</div>
			)}
		</Card>
	);
}

/** One knob row (a CSS var value or a data-bind text). */
const Knob = {
	view: ({ attrs: { name, value, onValue } }) => (
		<label class="tpl-knob">
			<span class="tpl-knob-name" title={name}>
				{name}
			</span>
			<input
				class="tpl-knob-input"
				value={value}
				oninput={(ev: Event) => onValue((ev.target as HTMLInputElement).value)}
			/>
		</label>
	),
} as MithrilJSXComponent<{
	name: string;
	value: string;
	onValue: (v: string) => void;
}>;

/** The editor pane for the selected template. */
function EditorPane() {
	if (!editor.open)
		return (
			<Card class="tpl-editor-card">
				<EmptyState message={t("tpl.select")} />
			</Card>
		);
	return (
		<Card
			class="tpl-editor-card"
			title={
				<span class="tpl-editor-title">
					{editor.id}
					{editor.dirty && (
						<span class="tpl-dirty" title={t("tpl.unsaved")}>
							{t("tpl.unsaved")}
						</span>
					)}
				</span>
			}
			headActions={
				<Actions>
					<Button
						label={t("ui.save")}
						class="tpl-save"
						disabled={editor.saving || !editor.dirty}
						onclick={() => void save()}
					/>
					<IconButton
						icon={<Icon name="delete" />}
						label={t("tpl.delete")}
						danger
						onclick={() => void remove()}
					/>
				</Actions>
			}
		>
			<div class="tpl-editor-body">
				<div class="tpl-tabs">
					<div class="tpl-tabbar" role="tablist">
						<button
							type="button"
							role="tab"
							class={editor.tab === "fields" ? "tpl-tab active" : "tpl-tab"}
							aria-selected={editor.tab === "fields"}
							onclick={() => {
								editor.tab = "fields";
								m.redraw();
							}}
						>
							{t("tpl.fields")}
						</button>
						<button
							type="button"
							role="tab"
							class={editor.tab === "html" ? "tpl-tab active" : "tpl-tab"}
							aria-selected={editor.tab === "html"}
							onclick={() => {
								editor.tab = "html";
								m.redraw();
							}}
						>
							{t("tpl.html")}
						</button>
					</div>
					{editor.tab === "fields" ? (
						<Card class="tpl-fields">
							<div class="tpl-fields-section">
								<h3>{t("tpl.css_vars")}</h3>
								{Object.keys(editor.vars).length === 0 ? (
									<p class="muted">{t("tpl.no_vars")}</p>
								) : (
									Object.entries(editor.vars).map(([name, value]) => (
										<Knob
											key={name}
											name={name}
											value={value}
											onValue={(v) => setVar(name, v)}
										/>
									))
								)}
							</div>
							<div class="tpl-fields-section">
								<h3>{t("tpl.bindings")}</h3>
								{Object.keys(editor.text).length === 0 ? (
									<p class="muted">{t("tpl.no_binds")}</p>
								) : (
									Object.entries(editor.text).map(([slot, value]) => (
										<Knob
											key={slot}
											name={slot}
											value={value}
											onValue={(v) => setBind(slot, v)}
										/>
									))
								)}
							</div>
						</Card>
					) : (
						<div class="tpl-code">
							<div class="tpl-code-area">
								<pre class="tpl-code-hl" aria-hidden="true">
									{m.trust(highlightHtml(editor.html))}
								</pre>
								<textarea
									class="tpl-html"
									wrap="off"
									spellCheck={false}
									value={editor.html}
									placeholder={t("tpl.html")}
									oninput={(ev: Event) =>
										applyHtml((ev.target as HTMLTextAreaElement).value)
									}
									onscroll={(ev: Event) => {
										const ta = ev.target as HTMLTextAreaElement;
										const pre =
											ta.previousElementSibling as HTMLPreElement | null;
										if (pre) {
											pre.scrollTop = ta.scrollTop;
											pre.scrollLeft = ta.scrollLeft;
										}
									}}
									onkeydown={(ev: KeyboardEvent) => {
										if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") {
											ev.preventDefault();
											void save();
										}
									}}
								/>
							</div>
							{!editor.valid && editor.docError && (
								<p class="tpl-doc-error" title={editor.docError}>
									{editor.docError}
								</p>
							)}
						</div>
					)}
				</div>
				<div class="tpl-preview">
					<div class="tpl-preview-head">
						<h3>{t("tpl.preview")}</h3>
						<div class="tpl-preview-size">
							<label class="check">
								<input
									type="checkbox"
									checked={previewSize.fit}
									onchange={(ev: Event) => {
										previewSize.fit = (ev.target as HTMLInputElement).checked;
										m.redraw();
									}}
								/>
								{t("tpl.preview_fit")}
							</label>
							<label class="tpl-size-field">
								{t("tpl.preview_width")}
								<input
									type="number"
									min={1}
									max={4096}
									value={previewSize.w}
									disabled={previewSize.fit}
									oninput={(ev: Event) => {
										const v = Number((ev.target as HTMLInputElement).value);
										if (Number.isFinite(v) && v >= 1)
											previewSize.w = Math.round(v);
										m.redraw();
									}}
								/>
							</label>
							<label class="tpl-size-field">
								{t("tpl.preview_height")}
								<input
									type="number"
									min={1}
									max={4096}
									value={previewSize.h}
									disabled={previewSize.fit}
									oninput={(ev: Event) => {
										const v = Number((ev.target as HTMLInputElement).value);
										if (Number.isFinite(v) && v >= 1)
											previewSize.h = Math.round(v);
										m.redraw();
									}}
								/>
							</label>
						</div>
					</div>
					<div
						class={
							previewSize.fit ? "tpl-preview-frame" : "tpl-preview-frame fixed"
						}
						style={
							previewSize.fit
								? undefined
								: { width: `${previewSize.w}px`, height: `${previewSize.h}px` }
						}
					>
						<iframe
							class="tpl-preview-doc"
							title={t("tpl.preview")}
							srcdoc={previewDoc}
							sandbox=""
						/>
					</div>
				</div>
			</div>
		</Card>
	);
}

const App: m.Component = {
	oncreate() {
		void refreshList();
	},
	view: () => (
		<Page nav={<ServerNav active="templates" />}>
			<div class="tpl-layout">
				{ListPane()}
				{EditorPane()}
			</div>
			<Toast message={toast.message} />
		</Page>
	),
};

void mountPage(() => t("tpl.title"), App);
void i18nReady.then(() => m.redraw());
