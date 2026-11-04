import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { templateDocUrl } from "../server/modules/overlay_templates/catalog";
import {
	buildTemplateConfig,
	namedStyleVars,
} from "../server/modules/overlay_templates/doc";
import { DEFAULT_HTML_TEMPLATE_PROPS } from "../server/modules/overlay_templates/overlay_schema";
import {
	readColorAlpha,
	writeColorAlpha,
} from "../server/modules/overlay_templates/templates/color_value";
import { scopeTemplateCss } from "../server/modules/overlay_templates/templates/css_scope";
import {
	escapeAttr,
	escapeHtml,
	renderTemplateDoc,
	templateBody,
} from "../server/modules/overlay_templates/templates/render_doc";
import {
	parseRootVars,
	rootVarLabel,
} from "../server/modules/overlay_templates/templates/root_vars";
import {
	type ParsedTemplateDoc,
	parseTemplateDoc,
} from "../server/modules/overlay_templates/templates/template_doc";
import type { TemplateMeta } from "../server/modules/overlay_templates/templates/template_meta";
import { parseElementInput } from "../shared/overlay";

// A template is one self-contained HTML document on disk
// (`public/overlay_templates/<id>/index.html`), served at runtime by the
// control server's `/overlay_templates/*` route. These tests read the same
// bytes straight from disk, keyed by template id.
const PUBLIC_TEMPLATES = new URL(
	"../public/overlay_templates/",
	import.meta.url,
);
function readTemplateRaw(templateId: string): string {
	return readFileSync(
		fileURLToPath(PUBLIC_TEMPLATES + templateId + "/index.html"),
		"utf8",
	);
}
function readTemplateDoc(templateId: string): ParsedTemplateDoc {
	return parseTemplateDoc(templateId, readTemplateRaw(templateId));
}
// The id vocabulary is what the server's `_catalog.json` route discovers:
// one folder per template under `public/overlay_templates` (nothing is
// maintained by hand). The schema validates ids as slugs, not against a
// frozen list.
function discoverTemplateIds(): string[] {
	return readdirSync(fileURLToPath(PUBLIC_TEMPLATES), {
		withFileTypes: true,
	})
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}
const TEMPLATE_IDS: string[] = discoverTemplateIds();
const TEMPLATE_FILES: Readonly<Record<string, ParsedTemplateDoc>> =
	Object.fromEntries([...TEMPLATE_IDS].map((id) => [id, readTemplateDoc(id)]));
// The static route's URL builder must agree with the on-disk layout the test
// reads from (both derive from the same `<id>` slug).
expect(templateDocUrl("lower_third_bar")).toBe(
	"/overlay_templates/lower_third_bar/index.html",
);

const TARGET_ID = "lower_third_bar";
const meta = TEMPLATE_FILES[TARGET_ID].meta;
const files = TEMPLATE_FILES[TARGET_ID];
const doc = (props: Record<string, unknown>, text?: Record<string, string>) =>
	renderTemplateDoc({
		meta,
		body: files.body,
		config: buildTemplateConfig({
			meta,
			props: { ...DEFAULT_HTML_TEMPLATE_PROPS, ...props },
			...(text ? { text } : {}),
		}),
	});

describe("overlay_templates: catalog", () => {
	test("the auto-discovered catalog is the on-disk folders", () => {
		// TEMPLATE_IDS is the discovery itself (folders under
		// public/overlay_templates, exactly what the server's
		// _catalog.json route computes) — it must name every advertised
		// template.
		expect(TEMPLATE_IDS).toEqual(
			[
				"brb",
				"corner_brackets",
				"countdown",
				"footer",
				"header",
				"lower_third_bar",
				"now_playing",
				"starting_soon",
				"ticker",
				"webcam_frame",
			].sort(),
		);
	});

	test("every template is one self-contained, inert html document", () => {
		for (const id of TEMPLATE_IDS) {
			const raw = readTemplateRaw(id);
			expect(raw.trimStart().toLowerCase().startsWith("<!doctype html>")).toBe(
				true,
			);
			expect(raw).toContain('<meta name="overlay-template:name"');
			// there is NO hand-listed uses meta — the parser derives it
			expect(raw).not.toContain("overlay-template:uses");
			expect(raw).not.toMatch(/<script/i);
			const f = TEMPLATE_FILES[id];
			expect(f.meta.id).toBe(id);
			expect(f.meta.name).toMatch(/^overlay\.tpl\./);
			expect(f.body.trimStart().startsWith("<section")).toBe(true);
			expect(f.body.trimEnd().endsWith("</section>")).toBe(true);
			expect(f.css).toContain(":root");
			expect(f.css).not.toMatch(/url\(|@import/i);
		}
	});

	test("every data-bind / data-asset slot in a template is consumed by its config", () => {
		for (const id of TEMPLATE_IDS) {
			const body = templateBody(TEMPLATE_FILES[id].body);
			const expectedText = { title: "x", subtitle: "y" } as Record<
				string,
				string
			>;
			for (const m of body.matchAll(/data-bind="([^"]+)"/g)) {
				const cfg = buildTemplateConfig({
					meta: TEMPLATE_FILES[id].meta,
					props: DEFAULT_HTML_TEMPLATE_PROPS,
					text: expectedText,
				});
				expect(cfg.text?.[m[1]]).toBe(expectedText[m[1]]);
			}
			for (const m of body.matchAll(/data-asset="([^"]+)"/g)) {
				const cfg = buildTemplateConfig({
					meta: TEMPLATE_FILES[id].meta,
					props: DEFAULT_HTML_TEMPLATE_PROPS,
					assets: { logo: "https://a/logo.png" },
				});
				expect(cfg.assets?.[m[1]]).toBe("https://a/logo.png");
			}
		}
	});
});

describe("overlay_templates: doc parser", () => {
	const doc = (body = '<span data-bind="title">x</span>') => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="overlay-template:name" content="overlay.tpl.t" />
    <style>
		:root {
			--a: 1px;
		}
    </style>
  </head>
  <body>
	<section>
${body}
	</section>
  </body>
</html>
`;

	test("a well-formed document parses to meta + css + body (uses derived)", () => {
		// data-bind="title" → title, the :root --a → vars
		const p = parseTemplateDoc("t", doc());
		expect(p.meta).toEqual({
			id: "t",
			name: "overlay.tpl.t",
			uses: ["title", "vars"],
		});
		expect(p.css).toContain(":root");
		expect(p.body).toContain('data-bind="title"');
		expect(p.body).not.toContain("<style");
	});

	test("uses is derived from the body hooks + :root vars", () => {
		expect(
			parseTemplateDoc(
				"t",
				doc(
					'<span data-bind="title"/> <span data-bind="subtitle"/>' +
						'<img data-asset="logo"/> <div data-countdown/>',
				),
			).meta.uses,
		).toEqual([
			"title",
			"subtitle",
			"vars",
			"logoAssetId",
			"mode",
			"targetIso",
		]);
		// no hooks, no :root → no uses
		expect(
			parseTemplateDoc("t", doc("").replace(":root {", ":rootx {")).meta.uses,
		).toEqual([]);
		// a bare countdown hook is still derived (mode + targetIso)
		expect(
			parseTemplateDoc(
				"t",
				doc("<div data-countdown/>").replace(":root {", ":rootx {"),
			).meta.uses,
		).toEqual(["mode", "targetIso"]);
	});

	test("a <script> anywhere is a breach", () => {
		expect(() =>
			parseTemplateDoc(
				"t",
				doc().replace("</head>", "<script>evil()</script></head>"),
			),
		).toThrow("<script>");
	});

	test("a missing name meta is a breach", () => {
		expect(() =>
			parseTemplateDoc(
				"t",
				doc().replace(/<meta name="overlay-template:name"[^>]*\/>\n/, ""),
			),
		).toThrow("name");
	});

	test("zero or two sections are a breach", () => {
		expect(() =>
			parseTemplateDoc("t", doc().replace(/<section>[\s\S]*<\/section>/, "")),
		).toThrow("exactly one <section>");
		expect(() =>
			parseTemplateDoc(
				"t",
				doc().replace("</section>", "</section><section></section>"),
			),
		).toThrow("exactly one <section>");
	});

	test("a missing <style> block is a breach", () => {
		expect(() =>
			parseTemplateDoc("t", doc().replace(/<style>[\s\S]*<\/style>/, "")),
		).toThrow("<style>");
	});
});

describe("overlay_templates: schema normalization", () => {
	const element = (props: Record<string, unknown>) =>
		parseElementInput({
			id: "el-1",
			name: "tpl",
			type: "html_template",
			transform: {
				x: 0,
				y: 0,
				width: 100,
				height: 50,
				rotation: 0,
				opacity: 1,
			},
			visible: true,
			bindings: {},
			props: { ...DEFAULT_HTML_TEMPLATE_PROPS, ...props },
		});

	test("out-of-range / malformed props fall back to defaults", () => {
		const p = element({
			fontSize: -3,
			radius: 9999,
			accentColor: "not-a-color",
			mode: "blink",
			templateId: "does-not-exist",
			title: "x".repeat(501),
		}).props;
		expect(p.fontSize).toBe(DEFAULT_HTML_TEMPLATE_PROPS.fontSize);
		expect(p.radius).toBe(DEFAULT_HTML_TEMPLATE_PROPS.radius);
		expect(p.accentColor).toBe(DEFAULT_HTML_TEMPLATE_PROPS.accentColor);
		expect(p.mode).toBe("static");
		expect(p.templateId).toBe(DEFAULT_HTML_TEMPLATE_PROPS.templateId);
		expect(String(p.title).length).toBe(500);
	});

	test("valid props pass through and unknown keys are kept", () => {
		const p = element({
			accentColor: "#AABBCC",
			fontSize: 40,
			mode: "countdown",
			targetIso: "2030-01-01T00:00:00Z",
			someFutureKnob: 1,
		}).props;
		expect(p.accentColor).toBe("#aabbcc");
		expect(p.fontSize).toBe(40);
		expect(p.mode).toBe("countdown");
		expect(p.targetIso).toBe("2030-01-01T00:00:00Z");
		expect(p.someFutureKnob).toBe(1);
	});

	test("vars are sanitized: --name keys, short strings, sorted, capped", () => {
		const p = element({
			vars: {
				"--zz-size": "1px",
				"--aa-color": "#ffffff",
				color: "not-a-var",
				"--": "x",
				"--toolong": "x".repeat(201),
				"--empty": "",
			},
		}).props;
		expect(p.vars).toEqual({ "--aa-color": "#ffffff", "--zz-size": "1px" });
	});

	test("legacy style props fold into vars only when non-default", () => {
		// fresh element: every named style prop at its default → no vars
		const fresh = element({}).props;
		expect(fresh.vars).toEqual({});
		// customized named props → folded into the matching custom properties
		const customized = element({
			accentColor: "#ff0000",
			padding: 40,
		}).props;
		expect(customized.vars).toEqual({
			"--accent": "#ff0000",
			"--padding": "40px",
		});
		// an explicit vars record wins over the fold
		const explicit = element({
			vars: { "--accent": "#00ff00" },
			accentColor: "#ff0000",
		}).props;
		expect(explicit.vars).toEqual({ "--accent": "#00ff00" });
	});
});

describe("overlay_templates: :root variable reader", () => {
	test("every template's :root block parses to one --name per entry", () => {
		for (const id of TEMPLATE_IDS) {
			const list = parseRootVars(TEMPLATE_FILES[id].css);
			expect(list.length).toBeGreaterThan(0);
			for (const [name, value] of list) {
				expect(name.startsWith("--")).toBe(true);
				expect(value.length).toBeGreaterThan(0);
			}
		}
	});

	test("corner_brackets exposes accent, padding and the glow, in order", () => {
		expect(parseRootVars(TEMPLATE_FILES["corner_brackets"].css)).toEqual([
			["--accent", "#6c5ce7"],
			["--padding", "24px"],
			["--corner-glow", "rgba(108, 92, 231, 0.4)"],
		]);
	});

	test("labels drop the -- prefix, join separators as spaces, cap the first letter", () => {
		expect(rootVarLabel("--corner-glow")).toBe("Corner glow");
		expect(rootVarLabel("--accent")).toBe("Accent");
		expect(rootVarLabel("--font-size")).toBe("Font size");
		expect(rootVarLabel("--padding")).toBe("Padding");
		expect(rootVarLabel("--a_b-c")).toBe("A b c");
	});

	test("comments are ignored; a missing :root yields []", () => {
		expect(
			parseRootVars(
				"/* hdr */\n:root {\n--a: 1px;\n/* mid */\n--b: #123456;\n}",
			),
		).toEqual([
			["--a", "1px"],
			["--b", "#123456"],
		]);
		expect(parseRootVars(".x { color: red }")).toEqual([]);
	});
});

describe("overlay_templates: colour-with-alpha values", () => {
	test("reads rgb/rgba/hsl/hsla/hex/hex8; rejects the rest", () => {
		expect(readColorAlpha("rgba(108, 92, 231, 0.4)")).toEqual({
			hex: "#6c5ce7",
			alpha: 0.4,
		});
		expect(readColorAlpha("rgb(255, 0, 0)")).toEqual({
			hex: "#ff0000",
			alpha: 1,
		});
		expect(readColorAlpha("#ff000080")).toEqual({
			hex: "#ff0000",
			alpha: 128 / 255,
		});
		expect(readColorAlpha("#6C5CE7")).toEqual({
			hex: "#6c5ce7",
			alpha: 1,
		});
		// hsl(285deg-ish) resolves to the same purple (rounded to 2 decimals)
		const hsl = readColorAlpha("hsla(255, 65.8%, 60.8%, 0.5)");
		expect(hsl?.alpha).toBe(0.5);
		expect(hsl?.hex).toMatch(/^#[0-9a-f]{6}$/);
		for (const v of ["inherit", "transparent", "rgb(999, 0, 0)", "url(x)"])
			expect(readColorAlpha(v)).toBeNull();
	});

	test("write/read round-trips the :root fallback shape exactly", () => {
		// the corner_brackets fallback is the contract: picker writes back
		// the SAME string, so resetting drops the override
		const ca = readColorAlpha("rgba(108, 92, 231, 0.4)")!;
		expect(writeColorAlpha(ca.hex, ca.alpha)).toBe("rgba(108, 92, 231, 0.4)");
		// full alpha normalises to rgb(..)
		expect(writeColorAlpha("#ff0000", 1)).toBe("rgb(255, 0, 0)");
		expect(writeColorAlpha("#000000", 0.9)).toBe("rgba(0, 0, 0, 0.9)");
		expect(writeColorAlpha("#6c5ce7", 0.4)).toBe("rgba(108, 92, 231, 0.4)");
		// the slider's 2-decimal step never leaks float noise
		expect(writeColorAlpha("#123456", 0.35000000000000003)).toBe(
			"rgba(18, 52, 86, 0.35)",
		);
	});
});

describe("overlay_templates: config builder", () => {
	test("default props yield no vars (the scoped :root fallbacks apply)", () => {
		const c = buildTemplateConfig({
			meta,
			props: DEFAULT_HTML_TEMPLATE_PROPS,
			text: {},
		});
		expect(c.vars).toBeUndefined();
	});

	test("vars ride the config only when the template uses them", () => {
		// lower_third_bar declares "vars" → the overrides are emitted
		const c = buildTemplateConfig({
			meta,
			props: {
				...DEFAULT_HTML_TEMPLATE_PROPS,
				vars: { "--accent": "#123456" },
			},
		});
		expect(c.vars).toEqual({ "--accent": "#123456" });
		// a template WITHOUT "vars" in `uses` cannot change when the record is edited
		const m2: TemplateMeta = {
			id: "no.vars",
			name: "x",
			uses: [],
		};
		const a = buildTemplateConfig({
			meta: m2,
			props: DEFAULT_HTML_TEMPLATE_PROPS,
		});
		const b = buildTemplateConfig({
			meta: m2,
			props: {
				...DEFAULT_HTML_TEMPLATE_PROPS,
				vars: { "--accent": "#ff0000" },
			},
		});
		expect(JSON.stringify(b)).toBe(JSON.stringify(a));
	});

	test("the named style writers keep their legacy folding (bgAlpha → --bg rgba)", () => {
		const v = (bgColor: string, bgAlpha: number) =>
			namedStyleVars({ ...DEFAULT_HTML_TEMPLATE_PROPS, bgColor, bgAlpha })[
				"--bg"
			];
		expect(v("#101020", 50)).toBe("rgba(16, 16, 32, 0.5)");
		expect(v("#101020", 0)).toContain(", 0)");
		expect(v("#101020", 100)).toContain(", 1)");
	});

	test("editing a prop the template does not use cannot change the config", () => {
		const base = buildTemplateConfig({
			meta,
			props: DEFAULT_HTML_TEMPLATE_PROPS,
			text: { title: "a", subtitle: "" },
		});
		// title is in `uses` → changes the config
		const titled = buildTemplateConfig({
			meta,
			props: DEFAULT_HTML_TEMPLATE_PROPS,
			text: { title: "b", subtitle: "" },
		});
		expect(JSON.stringify({ ...base })).not.toBe(JSON.stringify(titled));
		// logoAssetId is not in lower_third_bar's `uses` → identical config
		const logo = buildTemplateConfig({
			meta,
			props: { ...DEFAULT_HTML_TEMPLATE_PROPS, logoAssetId: "asset-1" },
			text: { title: "a", subtitle: "" },
			assets: { logo: "https://a/1.png" },
		});
		expect(JSON.stringify(logo)).toBe(JSON.stringify(base));
		// an unused countdown must not sneak a countdown target in
		const cd = buildTemplateConfig({
			meta,
			props: {
				...DEFAULT_HTML_TEMPLATE_PROPS,
				mode: "countdown",
				targetIso: "2030-01-01T00:00:00Z",
			},
		});
		expect(cd.countdown).toBeUndefined();
	});
});

describe("overlay_templates: doc renderer", () => {
	test("the wrapper carries the template class and the resolved vars", () => {
		const s = doc({ vars: { "--accent": "#123456", "--radius": "8px" } });
		expect(s.startsWith(`<div class="ov-tpl-${TARGET_ID}" style="`)).toBe(true);
		expect(s).toContain(`--accent:#123456`);
		expect(s).toContain(`--radius:8px`);
		expect(s).not.toContain(`--fit`);
		expect(s.endsWith(`</div>`)).toBe(true);
	});

	test("a hostile vars value cannot break out of the style attribute", () => {
		const s = doc({ vars: { "--accent": '#ff0000" onmouseover="alert(1)' } });
		expect(s).not.toContain(`onmouseover="alert(1)`);
		expect(s).toContain(escapeAttr('#ff0000" onmouseover="alert(1)'));
	});

	test("text slots are baked in entity-escaped (a hostile title cannot break out)", () => {
		const hostile = 'hi</div><script>alert(1)</script>&"q"';
		const s = doc({}, { title: hostile });
		// the raw hostile markup is neutralised to entities; the escaped form
		// is what lands in the fragment
		expect(s).not.toContain("</div><script>");
		expect(s).not.toContain("<script>alert(1)</script>");
		expect(s).toContain(escapeHtml(hostile));
	});

	test("a changed config yields a changed string; the same input is stable", () => {
		expect(doc({}, { title: "a" })).not.toBe(doc({}, { title: "b" }));
		expect(doc({}, { title: "a" })).toBe(doc({}, { title: "a" }));
	});

	test("the renderer never emits a <script> for a well-formed template", () => {
		expect(doc({})).not.toMatch(/<script/i);
	});

	test("baking fails loudly on a broken or hostile template fragment", () => {
		expect(() =>
			templateBody("<section><script>evil()</script></section>"),
		).toThrow("must not contain <script>");
		// a config that requests a text slot the template does not have
		expect(() =>
			renderTemplateDoc({
				meta,
				body: "<section></section>",
				config: { text: { title: "x" } },
			}),
		).toThrow(`data-bind="title"`);
	});

	test("logo assets land in the img src (the webcam_frame slot)", () => {
		const camMeta = TEMPLATE_FILES["webcam_frame"].meta;
		const camFiles = TEMPLATE_FILES["webcam_frame"];
		const s = renderTemplateDoc({
			meta: camMeta,
			body: camFiles.body,
			config: buildTemplateConfig({
				meta: camMeta,
				props: DEFAULT_HTML_TEMPLATE_PROPS,
				assets: { logo: 'https://cdn/x.png?a=1&q="b"' },
			}),
		});
		expect(s).toContain(`src="https://cdn/x.png?a=1&amp;q=&quot;b&quot;"`);
		// the <img> stays self-closing and the url is entity-escaped
		expect(s).toMatch(/<img[^>]*src="https:\/\/cdn\/x\.png[^"]*"\/>/);
		expect(s).not.toContain(`q="b"`);
	});
});

describe("overlay_templates: css scoper", () => {
	const wrap = ".ov-tpl-x";

	test(":root / html / body collapse onto the wrapper; * gets a wrapper prefix", () => {
		const out = scopeTemplateCss(
			":root {--a: 1} html, body {margin: 0} * {box-sizing: border-box}",
			wrap,
		);
		expect(out).toContain(".ov-tpl-x {--a: 1}");
		expect(out).toContain(".ov-tpl-x {margin: 0}");
		expect(out).toContain(".ov-tpl-x * {box-sizing: border-box}");
		expect(out).not.toMatch(/^:root|^html|^body/m);
	});

	test("class selectors are prefixed and @media recurses", () => {
		const out = scopeTemplateCss(
			".a {color: red} @media (max-width: 600px) {.b {color: blue}}",
			wrap,
		);
		expect(out).toContain(".ov-tpl-x .a {color: red}");
		expect(out).toContain("@media (max-width: 600px) {");
		expect(out).toContain("ov-tpl-x .b {color: blue}");
	});

	test("@keyframes are renamed per wrapper and their references patched", () => {
		const out = scopeTemplateCss(
			".t {animation: spin 1s linear infinite} @keyframes spin {from {transform: rotate(0)}}",
			wrap,
		);
		expect(out).toContain("@keyframes spin__ov-tpl-x");
		expect(out).toContain("animation: spin__ov-tpl-x 1s linear infinite");
		expect(out).not.toMatch(/animation: spin\b(?!__)/);
	});

	test("loose text, unsupported at-rules, unbalanced braces and compound roots fail loudly", () => {
		// a bare @import carries no block → it is "loose" (non-rule) text
		expect(() => scopeTemplateCss("@import url(a.css);", wrap)).toThrow(
			"non-rule text",
		);
		// a block-carrying at-rule that is not @media/@keyframes is unsupported
		expect(() =>
			scopeTemplateCss("@supports (a: b) {.x {color: red}}", wrap),
		).toThrow("unsupported at-rule");
		expect(() => scopeTemplateCss(".a {color: red", wrap)).toThrow(
			"unbalanced braces",
		);
		expect(() => scopeTemplateCss(":root .a {color: red}", wrap)).toThrow(
			"html/body/:root only as standalone selectors",
		);
	});

	test("comments between rules are ignored", () => {
		const out = scopeTemplateCss(
			"/* header */\n.a {color: red}\n/* mid */\n.b {color: blue}",
			wrap,
		);
		expect(out).toContain(".ov-tpl-x .a {color: red}");
		expect(out).toContain(".ov-tpl-x .b {color: blue}");
	});
});
