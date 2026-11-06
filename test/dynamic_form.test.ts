import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Window as HappyWindow } from "happy-dom";
import type m from "mithril";
import type {
	DynamicFormAttrs,
	FormSchema,
	Translate,
} from "../shared/ui/components/dynamic_form";

/*
 * DOM-level tests for DynamicForm (06-dynamic-form, Phase A). Mounts the REAL
 * component (happy-dom as the DOM) and verifies:
 *   1. every FieldType renders the right control,
 *   2. onChange emits the merged state with dotted keys expanded,
 *   3. labels / help / placeholders / option labels resolve through the
 *      injected `t` at render time — changing `t` re-renders without a
 *      schema rebuild (the live-translation contract),
 *   4. a missing key falls back to the raw key (and warns once),
 *   5. visibleWhen hides a field, 6. GroupSchema renders a legend + nested
 *      fields, 7. validate (and required) surface an error on the row.
 *
 * The pattern mirrors overlay_templates_vars_form.test.ts: set the happy-dom
 * globals BEFORE importing mithril / DynamicForm (they are imported
 * dynamically inside beforeAll), and restore the previous globals in afterAll
 * — bun test shares globalThis and the module cache across files.
 */

let win: HappyWindow;
let mithril: typeof import("mithril");
let DynamicForm: typeof import("../shared/ui/components/dynamic_form")["DynamicForm"];

// bun test shares globalThis across files — restore what we set afterward.
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
];

/** Live config the mounted wrapper reads on every view(). */
const cfg: DynamicFormAttrs = {
	schema: { fields: [] },
	value: {},
	onChange: undefined,
	onSubmit: undefined,
	disabled: undefined,
	t: (k: string, p?: Record<string, unknown>) =>
		p ? k : k, // identity by default
};

let root: HTMLElement | undefined;

afterAll(() => {
	const g = globalThis as Record<string, unknown>;
	for (const [key, original] of savedGlobals) g[key] = original;
	savedGlobals.length = 0;
});

beforeAll(async () => {
	const { Window } = await import("happy-dom");
	win = new Window();
	const g = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) savedGlobals.push([key, g[key] as unknown]);
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.requestAnimationFrame = win.requestAnimationFrame;
	g.cancelAnimationFrame = win.cancelAnimationFrame;

	const df = await import("../shared/ui/components/dynamic_form");
	mithril = (
		await import("mithril")
	).default as unknown as typeof import("mithril");
	DynamicForm = df.DynamicForm;
}, 15000);

/** Mount DynamicForm reading the live `cfg`; returns the root element. */
function mount(): HTMLElement {
	const el = win.document.createElement("div");
	win.document.body.appendChild(el);
	mithril.mount(el, {
		view: () =>
			mithril(
				DynamicForm,
				{
					schema: cfg.schema,
					value: cfg.value,
					onChange: cfg.onChange,
					onSubmit: cfg.onSubmit,
					disabled: cfg.disabled,
					t: cfg.t,
				},
			) as m.Vnode,
	});
	root = el;
	mithril.redraw();
	return el;
}

/** Trigger a re-render of the mounted form (after mutating cfg).
 *
 *  Happy-dom runs `requestAnimationFrame` on a timer, so the async
 *  `m.redraw()` is what actually flushes; `until` waits for the timer to fire.
 */
function redraw(): void {
	mithril.redraw();
}

/** Poll until `fn` holds (asking for a redraw each tick so the DOM settles). */
async function until(fn: () => boolean, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > ms)
			throw new Error("timed out waiting for condition");
		mithril.redraw();
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** Default `t` that turns `k` into a recognizable label. */
const labelT: Translate = (k, p) =>
	typeof p === "object" && p !== null
		? `${k}:${JSON.stringify(p)}`
		: k;

/** Set the value of the first matching input and dispatch its event. */
async function setControlValue(selector: string, value: string): Promise<void> {
	await until(() => (root as HTMLElement).querySelector(selector) !== null);
	const el = (root as HTMLElement).querySelector(selector) as HTMLInputElement;
	el.value = value;
	el.dispatchEvent(new win.Event("input", { bubbles: true }));
}

describe("DynamicForm field types", () => {
	const cases: [string, string][] = [
		["text", 'input[type="text"]'],
		["textarea", "textarea"],
		["number", 'input[type="number"]'],
		["range", 'input[type="range"]'],
		["select", "select"],
		["checkbox", 'input[type="checkbox"]'],
		["color", 'input[type="color"]'],
		["asset", "select"],
		["iso-datetime", 'input[type="datetime-local"]'],
	];

	test.each(cases)(
		"%s renders the %s control",
		(type, selector) => {
			const schema: FormSchema =
				type === "select" || type === "asset"
					? {
							fields: [
								{
									type: type as "select",
									name: "f",
									labelKey: "lbl",
									options: [
										{ value: "a", labelKey: "opt.a" },
										{ value: "b", labelKey: "opt.b" },
									],
								},
							],
						}
					: { fields: [{ type: type as "text", name: "f", labelKey: "lbl" }] };
			cfg.schema = schema;
			cfg.value = {};
			cfg.t = labelT;
			mount();
			expect(
				(root as HTMLElement).querySelector(selector),
				`expected ${selector} for ${type}`,
			).not.toBeNull();
		},
	);
});

describe("DynamicForm control flow", () => {
	const changes: Record<string, unknown>[] = [];

	beforeEach(() => {
		changes.length = 0;
		cfg.onChange = (next) => changes.push(next);
	});

	test("onChange emits merged state with dotted keys expanded", async () => {
		cfg.schema = {
			fields: [
				{
					type: "text",
					name: "vars.accent",
					labelKey: "lbl.vars",
				},
			],
		};
		cfg.value = { vars: { accent: "old" } };
		cfg.t = labelT;
		mount();
		await setControlValue('input[type="text"]', "#ff0000");
		await until(() => changes.length > 0);
		expect(changes[changes.length - 1]).toEqual({
			vars: { accent: "#ff0000" },
		});
	});

	test("editing does not mutate the passed value object", async () => {
		const initial = { vars: { accent: "old" } };
		cfg.schema = {
			fields: [
				{ type: "text", name: "vars.accent", labelKey: "lbl.vars" },
			],
		};
		cfg.value = initial;
		cfg.t = labelT;
		mount();
		await setControlValue('input[type="text"]', "new");
		await until(() => changes.length > 0);
		expect(initial).toEqual({ vars: { accent: "old" } });
	});

	test("labelParams resolve from the live value (i18next {{n}})", async () => {
		// i18next uses `{{name}}`, not the `{name}` the spec sketch shows.
		cfg.schema = {
			fields: [
				{
					type: "text",
					name: "vars.name",
					labelKey: "dyn.lbl",
					labelParams: { name: "vars.name" },
				},
			],
		};
		cfg.value = { vars: { name: "World" } };
		cfg.t = (k, p) => `${k}::${p?.["name"]}`;
		mount();
		await until(() =>
			(root as HTMLElement).textContent?.includes("dyn.lbl::World"),
		);
	});

	test("checkbox toggles a boolean", async () => {
		cfg.schema = {
			fields: [
				{ type: "checkbox", name: "on", labelKey: "lbl.on" },
			],
		};
		cfg.value = { on: false };
		cfg.t = labelT;
		mount();
		await until(() =>
			(root as HTMLElement).querySelector('input[type="checkbox"]') !==
			null,
		);
		const cb = (root as HTMLElement).querySelector(
			'input[type="checkbox"]',
		) as HTMLInputElement;
		cb.checked = true;
		cb.dispatchEvent(new win.Event("change", { bubbles: true }));
		await until(() => changes.length > 0);
		expect(changes[changes.length - 1]).toEqual({ on: true });
	});
});

describe("DynamicForm label resolution through t", () => {
	test("changing t re-renders the label without rebuilding the schema", async () => {
		const schema: FormSchema = {
			fields: [
				{ type: "text", name: "title", labelKey: "df.title" },
			],
		};
		cfg.schema = schema;
		cfg.value = { title: "x" };
		cfg.t = (k: string) => (k === "df.title" ? "TITLE_EN" : k);
		mount();
		await until(() =>
			(root as HTMLElement).innerHTML.includes("TITLE_EN"),
		);

		// New schema-free translation — the same mounted schema re-renders.
		cfg.t = (k: string) => (k === "df.title" ? "TITLE_CS" : k);
		redraw();
		await until(() =>
			(root as HTMLElement).innerHTML.includes("TITLE_CS"),
		);
		expect(
			(root as HTMLElement).innerHTML.includes("TITLE_EN"),
		).toBe(false);
	});

	test("labelParams interpolate and help/placeholder resolve", async () => {
		cfg.schema = {
			fields: [
				{
					type: "text",
					name: "f",
					labelKey: "lbl",
					labelParams: { name: "accent" },
					helpKey: "help",
					placeholderKey: "ph",
				},
			],
		};
		cfg.value = {};
		cfg.t = (k: string, p?: Record<string, unknown>) => {
			if (k === "lbl") return `Lbl ${p?.["name"]}`;
			if (k === "help") return "HelpText";
			if (k === "ph") return "PhText";
			return k;
		};
		mount();
		await until(() => (root as HTMLElement).innerHTML.includes("Lbl accent"));
		expect((root as HTMLElement).innerHTML.includes("HelpText")).toBe(true);
		const input = (root as HTMLElement).querySelector(
			'input[type="text"]',
		) as HTMLInputElement;
		expect(input.placeholder).toBe("PhText");
	});

	test("select option labels resolve through t", async () => {
		cfg.schema = {
			fields: [
				{
					type: "select",
					name: "mode",
					labelKey: "lbl.mode",
					options: [
						{ value: "static", labelKey: "opt.static" },
						{ value: "countdown", labelKey: "opt.countdown" },
					],
				},
			],
		};
		cfg.value = { mode: "static" };
		cfg.t = (k: string) =>
			({ "opt.static": "Static", "opt.countdown": "Countdown", "lbl.mode": "Mode" }[
				k
			] ?? k);
		mount();
		await until(() => (root as HTMLElement).querySelectorAll("option").length === 2);
		const opts = Array.from(
			(root as HTMLElement).querySelectorAll("option"),
		).map((o) => o.textContent);
		expect(opts).toEqual(["Static", "Countdown"]);

		// Switch language live: options re-resolve, schema unchanged.
		cfg.t = (k: string) =>
			({ "opt.static": "Statický", "opt.countdown": "Odpočet" }[k] ?? k);
		redraw();
		await until(() =>
			Array.from((root as HTMLElement).querySelectorAll("option")).map(
				(o) => o.textContent,
			).join("|") === "Statický|Odpočet",
		);
	});
});

describe("DynamicForm missing-key fallback", () => {
	test("a missing key renders the raw key and warns once", async () => {
		let warned = 0;
		const originalWarn = console.warn;
		console.warn = () => {
			warned += 1;
		};
		try {
			cfg.schema = {
				fields: [
					{ type: "text", name: "f", labelKey: "does.not.exist" },
				],
			};
			cfg.value = {};
			cfg.t = (k: string) => k; // identity ⇒ i18next "missing"
			mount();
			await until(() =>
				(root as HTMLElement).innerHTML.includes("does.not.exist"),
			);
			expect(
				(root as HTMLElement).innerHTML.includes("does.not.exist"),
			).toBe(true);
			expect(warned).toBeGreaterThanOrEqual(1);
		} finally {
			console.warn = originalWarn;
		}
	});
});

describe("DynamicForm visibleWhen", () => {
	test("hides the field while the target differs and shows it when equal", async () => {
		cfg.schema = {
			fields: [
				{
					type: "text",
					name: "targetIso",
					labelKey: "lbl.iso",
					visibleWhen: { field: "mode", equals: "countdown" },
				},
			],
		};
		cfg.value = { mode: "static" };
		cfg.t = labelT;
		mount();
		await until(
			() =>
				(root as HTMLElement).querySelector('input[name="targetIso"]') ===
				null,
		);

		cfg.value = { mode: "countdown" };
		redraw();
		await until(
			() =>
				(root as HTMLElement).querySelector('input[name="targetIso"]') !==
				null,
		);
	});
});

describe("DynamicForm groups and validation", () => {
	test("GroupSchema renders a legend and nested fields", async () => {
		cfg.schema = {
			fields: [
				{
					type: "group",
					legendKey: "grp.style",
					fields: [
						{ type: "text", name: "a", labelKey: "lbl.a" },
						{ type: "color", name: "b", labelKey: "lbl.b" },
					],
				},
			],
		};
		cfg.value = {};
		cfg.t = (k: string) =>
			({ "grp.style": "Style Group" }[k] ?? k);
		mount();
		await until(() =>
			(root as HTMLElement).querySelector("legend") !== null,
		);
		expect(
			(root as HTMLElement).querySelector("legend")?.textContent,
		).toContain("Style Group");
		expect(
			(root as HTMLElement).querySelectorAll("input"),
		).toHaveLength(2);
	});

	test("validate surfaces an error and clears when valid", async () => {
		cfg.schema = {
			fields: [
				{
					type: "text",
					name: "f",
					labelKey: "lbl.f",
					validate: (v) =>
						v === "bad" ? "err.bad" : v === "good" ? null : "err.empty",
				},
			],
		};
		cfg.value = { f: "bad" };
		cfg.t = (k: string) =>
			({ "err.bad": "Invalid value", "err.empty": "Empty" }[k] ?? k);
		mount();
		await until(() =>
			(root as HTMLElement).querySelector(".df-error")?.textContent ===
			"Invalid value",
		);

		cfg.value = { f: "good" };
		redraw();
		await until(() =>
			(root as HTMLElement).querySelector(".df-error") === null,
		);
	});

	test("required marks an empty field with the required message", async () => {
		cfg.schema = {
			fields: [
				{ type: "text", name: "f", labelKey: "lbl.f", required: true },
			],
		};
		cfg.value = {};
		cfg.t = (k: string) =>
			({ "dynamic_form.required": "Required field" }[k] ?? k);
		mount();
		await until(() =>
			(root as HTMLElement).querySelector(".df-error")?.textContent ===
			"Required field",
		);
	});
});
