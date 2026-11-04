import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Window as HappyWindow } from "happy-dom";
import type m from "mithril";

/*
 * DOM-level test of the `:root`-driven inspector: mounts the REAL edit form
 * (the browser half, happy-dom as the DOM) against a corner_brackets element
 * and verifies that
 *   1. one field appears per `:root` variable of the template's <style>
 *      (fetched through the same code path as the render — a stubbed
 *      `fetch` serving the on-disk bytes),
 *   2. the control shape follows the fallback's (color / number / text),
 *   3. editing a field writes the override into `props.vars`, and editing it
 *      back to the `:root` default DROPS the override.
 *
 * The heavy UI leaves the form imports (i18n, the icon registry, the asset
 * picker) are stubbed through a test-scoped plugin — the form under test only
 * needs bindField's labelled rows.
 */

// The form's heavier imports (i18n, the icon registry, the asset picker)
// load fine under a plain import — i18n resolves to its key when no catalog
// is initialised and nothing touches the DOM at module scope. Stubbing them
// through a Bun.plugin is NOT an option here: bun test shares globalThis AND
// the module cache across concurrently-run test files, and a file-scoped
// transform leaks into them, quietly dropping their test registrations.

type Def =
	typeof import("../server/modules/overlay_templates/overlay_elements")[number];

type Mutate = (fn: (el: { props: Record<string, unknown> }) => void) => void;

interface FakeEl {
	id: string;
	type: string;
	visible: boolean;
	transform: Record<string, number>;
	bindings: Record<string, unknown>;
	props: Record<string, unknown>;
}

let win: HappyWindow;
let mithril: typeof import("mithril");
let getRoot: () => HTMLElement;
let formFor: (el: FakeEl, mutate: Mutate) => { root: HTMLElement };

// bun test shares globalThis across test files: the DOM globals AND THE
// FETCH STUB set below must be restored afterwards — a leaked fake fetch
// breaks the real-server tests in other files.
const savedGlobals: [string, unknown][] = [];
const GLOBAL_KEYS: (keyof typeof globalThis)[] = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"fetch",
];

afterAll(() => {
	const g = globalThis as Record<string, unknown>;
	for (const [key, original] of savedGlobals) g[key] = original;
	savedGlobals.length = 0;
});

// Serve the template bytes the way the control server's static route does.
const PUBLIC_TEMPLATES = new URL(
	"../public/overlay_templates/",
	import.meta.url,
);
const fetchBytes = (url: string): string => {
	const path = new URL(url, "http://x/").pathname;
	// the server's auto-discovery route, not a static file: one entry per
	// on-disk `*.html` template file (id = filename minus the extension)
	if (path === "/overlay_templates/_catalog.json")
		return JSON.stringify(
			readdirSync(fileURLToPath(PUBLIC_TEMPLATES), { withFileTypes: true })
				.filter((e) => e.isFile() && e.name.endsWith(".html"))
				.map((e) => e.name.slice(0, -".html".length))
				.sort(),
		);
	return readFileSync(
		fileURLToPath(
			new URL(path.replace(/^\/overlay_templates\//, ""), PUBLIC_TEMPLATES),
		),
		"utf8",
	);
};

beforeAll(async () => {
	const { Window } = await import("happy-dom");
	win = new Window();
	const g = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) savedGlobals.push([key, g[key] as unknown]);
	// Wire the happy-dom window up as the global DOM before Mithril loads
	// so its real DOM path (mount, diff, requestAnimationFrame) runs.
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.requestAnimationFrame = win.requestAnimationFrame;
	g.cancelAnimationFrame = win.cancelAnimationFrame;
	// the element host and the var-field loader both ride global fetch;
	// everything else delegates to the REAL fetch (other files'
	// real-server tests run concurrently against this shared global)
	const realFetch = g.fetch as typeof fetch;
	g.fetch = (url: RequestInfo | URL, init?: RequestInit) => {
		const path =
			typeof url === "string" ? url : url instanceof URL ? url.pathname : "";
		if (!path.startsWith("/overlay_templates/")) return realFetch(url, init);
		return Promise.resolve({
			text: () => Promise.resolve(fetchBytes(path)),
		}) as Promise<Response>;
	};

	const { default: elements } = await import(
		"../server/modules/overlay_templates/overlay_elements"
	);
	mithril = (await import("mithril")) as typeof mithril;
	getRoot = () => {
		const el = win.document.createElement("div");
		win.document.body.appendChild(el);
		return el;
	};
	// Mount the real edit form; the view closure re-runs on every redraw
	// so the fields read the CURRENT props (a mutate then a m.redraw).
	formFor = (el, mutate) => {
		const root = getRoot();
		const def = elements[0] as Def;
		mithril.mount(root, {
			view: () =>
				def.editForm({
					element: el as never,
					mutate,
					variables: [],
				}) as m.Vnode,
		});
		return { root };
	};
}, 15000);

/** Poll until `fn` holds (the fetch + m.redraw are both async). */
async function until(fn: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end)
			throw new Error("timed out waiting for the form to settle");
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** The labelled field rows of the mounted form (`input` = the first
 * control, `inputs` = every control — the colour-with-alpha field has two). */
function fields(root: HTMLElement): Array<{
	label: string;
	input: HTMLInputElement | null;
	inputs: HTMLInputElement[];
}> {
	return [...root.querySelectorAll(".ov-field")].map((f) => ({
		label: (f.querySelector(".ov-lbl")?.textContent ?? "").trim(),
		input: f.querySelector("input") as HTMLInputElement | null,
		inputs: [...f.querySelectorAll("input")] as HTMLInputElement[],
	}));
}

function input(el: HTMLInputElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new win.Event("input", { bubbles: true }));
}

describe("overlay_templates: the :root-driven inspector", () => {
	test("one field per :root variable, shaped by the fallback, writing props.vars", async () => {
		const el: FakeEl = {
			id: "el-1",
			type: "html_template",
			visible: true,
			transform: {
				x: 0,
				y: 0,
				width: 800,
				height: 600,
				rotation: 0,
				opacity: 1,
			},
			bindings: {},
			props: { templateId: "corner_brackets", vars: {} },
		};
		// like the real editor: a mutate is followed by a redraw, so the
		// re-rendered controls read the CURRENT props (the colour/alpha
		// pair's handlers both close over the rendered value)
		const mutate: Mutate = (fn) => {
			fn(el);
			mithril.redraw();
		};
		const { root } = formFor(el, mutate);

		// the var fields' labels are name-derived (`--accent` → `Accent` …)
		const VAR_LABELS = new Set(["Accent", "Corner glow", "Padding"]);

		// before the css bytes arrive the var section is empty (by design)
		expect(fields(root).some((f) => VAR_LABELS.has(f.label))).toBe(false);

		// the fetch resolves → m.redraw → one field per corner_brackets :root var
		await until(() => fields(root).some((f) => f.label === "Accent"));
		const byLabel = Object.fromEntries(
			fields(root)
				.filter((f) => VAR_LABELS.has(f.label))
				.map((f) => [f.label, f.input]),
		);
		expect(Object.keys(byLabel).sort()).toEqual([
			"Accent",
			"Corner glow",
			"Padding",
		]);

		// control shape follows the :root fallback:
		//   #6c5ce7 → colour picker,  24px → number (px),
		//   rgba(…) → colour picker + alpha slider
		expect(byLabel["Accent"]?.type).toBe("color");
		expect(byLabel["Accent"]?.value).toBe("#6c5ce7");
		expect(byLabel["Padding"]?.type).toBe("number");
		expect(byLabel["Padding"]?.value).toBe("24");
		const glowInputs = fields(root).find(
			(f) => f.label === "Corner glow",
		)!.inputs;
		expect(byLabel["Corner glow"]?.type).toBe("color");
		expect(byLabel["Corner glow"]?.value).toBe("#6c5ce7");
		expect(glowInputs[1]?.type).toBe("range");
		expect(glowInputs[1]?.value).toBe("0.4");

		// edit a control, then let the redraw land so the re-rendered
		// handlers close over the CURRENT props again
		const step = async (inp: HTMLInputElement, v: string) => {
			input(inp, v);
			await new Promise((r) => setTimeout(r, 0));
		};

		// editing writes the (raw --name) override into props.vars
		await step(byLabel["Accent"]!, "#ff0000");
		expect(el.props.vars).toEqual({ "--accent": "#ff0000" });
		await step(byLabel["Padding"]!, "40");
		expect(el.props.vars).toEqual({
			"--accent": "#ff0000",
			"--padding": "40px",
		});
		// the colour-with-alpha control writes the fallback's own shape,
		// keeping the other control's value (colour edits keep the alpha)
		await step(glowInputs[0]!, "#000000");
		expect(el.props.vars["--corner-glow"]).toBe("rgba(0, 0, 0, 0.4)");
		await step(glowInputs[1]!, "0.9");
		expect(el.props.vars).toEqual({
			"--accent": "#ff0000",
			"--corner-glow": "rgba(0, 0, 0, 0.9)",
			"--padding": "40px",
		});

		// editing back to the :root default DROPS the override
		await step(byLabel["Accent"]!, "#6c5ce7");
		expect(el.props.vars).not.toHaveProperty("--accent");
		// … and so does the glow, once both controls land on the fallback
		await step(glowInputs[1]!, "0.4");
		expect(el.props.vars["--corner-glow"]).toBe("rgba(0, 0, 0, 0.4)");
		await step(glowInputs[0]!, "#6c5ce7");
		expect(el.props.vars).not.toHaveProperty("--corner-glow");
		expect(el.props.vars).toEqual({ "--padding": "40px" });
	});

	test("ticker's font knobs: --font-size is a number field, --font is text", async () => {
		const el: FakeEl = {
			id: "el-ticker",
			type: "html_template",
			visible: true,
			transform: {
				x: 0,
				y: 0,
				width: 800,
				height: 60,
				rotation: 0,
				opacity: 1,
			},
			bindings: {},
			props: { templateId: "ticker", vars: {} },
		};
		const mutate: Mutate = (fn) => {
			fn(el);
			mithril.redraw();
		};
		const { root } = formFor(el, mutate);

		// --font-size → "Font size" (number), --font → "Font" (text)
		await until(() =>
			fields(root).some((f) => f.label === "Font size"),
		);
		const byLabel = Object.fromEntries(
			fields(root)
				.filter((f) => f.label === "Font size" || f.label === "Font")
				.map((f) => [f.label, f.input]),
		);
		expect(Object.keys(byLabel).sort()).toEqual(["Font", "Font size"]);

		// --font-size: 22px → number input holding 22 (the px unit is shown
		// beside it, not part of the value)
		expect(byLabel["Font size"]?.type).toBe("number");
		expect(byLabel["Font size"]?.value).toBe("22");
		// --font: "Inter", sans-serif → free-text input holding the stack
		expect(byLabel["Font"]?.type).toBe("text");
		expect(byLabel["Font"]?.value).toBe('"Inter", sans-serif');

		// editing writes the raw --name override into props.vars
		const step = async (inp: HTMLInputElement, v: string) => {
			input(inp, v);
			await new Promise((r) => setTimeout(r, 0));
		};
		await step(byLabel["Font size"]!, "30");
		expect(el.props.vars).toEqual({ "--font-size": "30px" });
		await step(byLabel["Font"]!, "Georgia, serif");
		expect(el.props.vars).toEqual({
			"--font": "Georgia, serif",
			"--font-size": "30px",
		});

		// editing back to the :root default DROPS the override
		await step(byLabel["Font size"]!, "22");
		expect(el.props.vars).not.toHaveProperty("--font-size");
		await step(byLabel["Font"]!, '"Inter", sans-serif');
		expect(el.props.vars).not.toHaveProperty("--font");
		expect(el.props.vars).toEqual({});
	});
});
