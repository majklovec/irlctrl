import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { appPath } from "../shared/paths";
import type { Vnode } from "mithril";

/*
 * Regression: switching an `html_template` element to a different template
 * must inject that template's scoped <style> **without a page refresh**.
 *
 * The host <div> in `draw` is keyed by `templateId`, so Mithril remounts the
 * subtree on a template change — firing `oncreate`, which calls `injectStyles`
 * for the newly-selected template. Before the key was added, `oncreate`
 * fired only once (first creation) and switching templates left the new one
 * unstyled until a full page refresh.
 *
 * This drives the real `htmlTemplateElement.draw` against a happy-dom window
 * and the real Mithril mount/diff path (the same harness chat_live_update uses).
 */

type ElementDef = {
	draw: (
		element: {
			id: string;
			name: string;
			type: string;
			transform: { x: number; y: number; width: number; height: number; rotation: number };
			visible: boolean;
			locked: boolean;
			parentId: string | null;
			props: Record<string, unknown>;
		},
		ctx: unknown,
	) => Vnode;
};

let draw: ElementDef["draw"];
let mithril: typeof import("mithril");
let getHead: () => HTMLHeadElement;
let getRoot: () => HTMLElement;

// Each template is ONE self-contained HTML document in the statically-served
// "assets/overlay_templates/" directory. Stub globalThis.fetch to serve those
// bytes so the *real* draw -> paintHost -> loadFiles path works in happy-dom
// with no live server.
const publicTemplatesDir = appPath("assets/overlay_templates");
const servedTemplateFiles: Record<string, string> = {};
for (const id of ["lower_third_bar", "header", "brb"]) {
  servedTemplateFiles[id] = readFileSync(
    `${publicTemplatesDir}/${id}.html`,
    "utf-8",
  );
}
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  const m = /overlay_templates\/([a-z0-9_]+)\.html/.exec(url);
  const body = m ? servedTemplateFiles[m[1]] : null;
  return Promise.resolve(
    new Response(body, {
      status: body == null ? 404 : 200,
      headers: { "content-type": "text/plain" },
    }),
  );
}) as typeof fetch;

beforeAll(async () => {
	const { Window } = await import("happy-dom");
	const win = new Window();
	const g = globalThis as Record<string, unknown>;
	// Wire the happy-dom window up as the global DOM before Mithril loads so its
	// real DOM path (mount, diff, requestAnimationFrame) runs.
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.requestAnimationFrame = win.requestAnimationFrame;
	g.cancelAnimationFrame = win.cancelAnimationFrame;

	const i18nStub =
		"export const currentLanguage = () => 'en'; export const t = (k) => k; export const i18nReady = Promise.resolve();";
	// `asset_picker` pulls `Modal` from the components barrel; nothing in the
	// `draw` path renders it, so a stub component is enough to load the module.
	const compStub =
		"export const Modal = (p) => (p && p.body) || null;";

	const result = await Bun.build({
		entrypoints: [
			new URL(
				"../server/pages/overlays/modules/overlay_templates/element.tsx",
				import.meta.url,
			).pathname,
		],
		target: "browser",
		format: "cjs",
		external: ["mithril"],
		loader: { ".css": "text" },
		plugins: [
			{
				name: "overlay-template-switch-shell",
				setup(b: {
					onLoad(o: { filter: RegExp }, cb: () => { contents: string; loader: string }): void;
				}) {
					b.onLoad({ filter: /shared\/ui\/i18n\.tsx$/ }, () => ({
						contents: i18nStub,
						loader: "js",
					}));
					b.onLoad({ filter: /shared\/ui\/components\/index\.tsx$/ }, () => ({
						contents: compStub,
						loader: "js",
					}));
				},
			},
		],
	});
	if (!result.success)
		throw new AggregateError(result.logs, "html_template switch test bundle failed");

	const require = createRequire(import.meta.url);
	const mod = { exports: {} };
	new Function(
		"module",
		"exports",
		"require",
		"window",
		"document",
		await result.outputs[0].text(),
	)(mod, mod.exports, require, win, win.document);
	draw = (mod.exports as { htmlTemplateElement: ElementDef }).htmlTemplateElement.draw;
	mithril = require("mithril") as typeof mithril;
	getHead = () => win.document.head;
	getRoot = () => {
		const el = win.document.createElement("div");
		win.document.body.appendChild(el);
		return el;
	};
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	const g = globalThis as Record<string, unknown>;
	for (const key of [
		"window",
		"document",
		"navigator",
		"HTMLElement",
		"Element",
		"Node",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	])
		delete g[key];
});

const FLUSH = () => new Promise((r) => setTimeout(r, 30));

/** The <head> textContent of the style scoped to a given template wrapper. */
function injectedStyleFor(wrapperClass: string): string | undefined {
	for (const el of Array.from(getHead().querySelectorAll("style"))) {
		const text = el.textContent ?? "";
		if (text.includes(`.${wrapperClass}`)) return text;
	}
	return undefined;
}

function makeElement(templateId: string) {
	return {
		id: "tmpl-1",
		name: "html_template",
		type: "html_template",
		transform: { x: 0, y: 0, width: 960, height: 240, rotation: 0 },
		visible: true,
		locked: false,
		parentId: null,
		props: { templateId, title: "T", subtitle: "S" },
	};
}

const ctx = {
	assetUrls: new Map<string, string>(),
	variables: new Map<string, unknown>(),
	variableNames: new Map<string, unknown>(),
};

describe("html_template: switching templates restyles without a page refresh", () => {
	test("the newly-selected template's <style> is injected on a plain redraw", async () => {
		const root = getRoot();
		let element = makeElement("lower_third_bar");
		// Mirror `overlayElementView`: `draw`'s output is the single child of a
		// wrapper keyed by `element.id`, so the element is one node among its
		// siblings in the scene fragment (not a bare keyed vnode in a fragment).
		const wrap = (el: typeof element) =>
			mithril(".overlay-element", { key: el.id, style: {} }, draw(el, ctx));
		mithril.mount(root, { view: () => [wrap(element)] });
		await FLUSH();

		// First render injects the initial template's scoped style.
		expect(injectedStyleFor("ov-tpl-lower_third_bar")).toBeDefined();

		// Switch to a template whose style was never added. No page refresh —
		// just a prop change + redraw, the way the editor updates the element.
		element = makeElement("header");
		mithril.redraw();
		await FLUSH();

		// The new template's scoped style must now be present in <head>.
		expect(injectedStyleFor("ov-tpl-header")).toBeDefined();
		// …and the previous template's <style> is removed (not piled on).
		expect(injectedStyleFor("ov-tpl-lower_third_bar")).toBeUndefined();

		// And the host renders the new template's wrapper markup.
		expect(root.querySelector(".ov-tpl-header")).not.toBeNull();

		// A third template: switching again keeps injecting the right style
		// and sheds the previous one.
		element = makeElement("brb");
		mithril.redraw();
		await FLUSH();
		expect(injectedStyleFor("ov-tpl-brb")).toBeDefined();
		expect(injectedStyleFor("ov-tpl-header")).toBeUndefined();
		expect(root.querySelector(".ov-tpl-brb")).not.toBeNull();
	});
});
