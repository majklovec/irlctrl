import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Window as HappyWindow } from "happy-dom";
import type { Vnode } from "mithril";

/*
 * DOM-level test of `bindableForm` (shared/ui/overlay/fields.tsx) against the
 * real browser half (happy-dom as the DOM): mounts the real builder with a
 * descriptor and verifies
 *   1. each field type renders the right control with the right value/attrs,
 *   2. the chain toggle appears exactly where `isBindable` allows
 *      (text/number/color — not select/checkbox),
 *   3. rows lay out in `ov-grid2`/`ov-grid3`; a raw Vnode row renders
 *      verbatim and never gains a toggle,
 *   4. the binding affordance writes `bindings[path]` through `mutate`, and
 *   5. control edits round-trip typed values (number → Number, checkbox →
 *      boolean) through `mutate`.
 *
 * i18n resolves to its key when no catalog is initialised, so label
 * assertions compare against the descriptor's `labelKey` verbatim.
 */

type Mutate = (fn: (el: FakeEl) => void) => void;

interface FakeEl {
	id: string;
	type: string;
	visible: boolean;
	transform: Record<string, number>;
	bindings: Record<string, unknown>;
	props: Record<string, unknown>;
}

interface Variable {
	id: string;
	name: string;
	type: string;
}

let win: HappyWindow;
let mithril: typeof import("mithril");
let vnode: (...args: unknown[]) => Vnode;
let getRoot: () => HTMLElement;
let bindableForm: (attrs: {
	element: FakeEl;
	mutate: Mutate;
	variables: Variable[];
	variableUrl?: (name: string) => string;
	rows: Row[];
}) => Vnode;
type Row = import("../shared/ui/overlay/fields").FormRow;

// bun test shares globalThis across test files: the DOM globals set below
// must be restored afterwards — a leaked window/document breaks the
// real-server tests in other files.
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

	const fields = await import("../shared/ui/overlay/fields");
	bindableForm = fields.bindableForm as unknown as typeof bindableForm;
	mithril = (await import("mithril")) as typeof mithril;
	vnode = mithril.default as (...args: unknown[]) => Vnode;
	getRoot = () => {
		const el = win.document.createElement("div");
		win.document.body.appendChild(el);
		return el;
	};
}, 15000);

/** Poll until `fn` holds (m.redraw runs on an animation frame). */
async function until(fn: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end)
			throw new Error("timed out waiting for the form to settle");
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** Mount `bindableForm` on a fresh root; returns the root + a mutate that
 * applies to `el` and schedules a redraw (like the real editor). */
function mount(
	el: FakeEl,
	rows: Row[],
	variables: Variable[] = [],
): { root: HTMLElement; mutate: Mutate } {
	const root = getRoot();
	const mutate: Mutate = (fn) => {
		fn(el);
		void mithril.redraw();
	};
	mithril.mount(root, {
		view: () =>
			bindableForm({ element: el, mutate, variables, rows }) as Vnode,
	});
	return { root, mutate };
}

function fresh(props: Record<string, unknown> = {}): FakeEl {
	return {
		id: `el-${Math.random()}`,
		type: "test",
		visible: true,
		transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1 },
		bindings: {},
		props,
	};
}

function input(el: HTMLInputElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new win.Event("input", { bubbles: true }));
}
function changeEl(el: HTMLSelectElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new win.Event("change", { bubbles: true }));
}
function click(el: HTMLElement): void {
	el.dispatchEvent(new win.Event("click", { bubbles: true }));
}

const VAR: Variable = { id: "v-1", name: "title", type: "text" };

describe("bindableForm: control rendering", () => {
	test("text / color / number / select / checkbox render the right control", () => {
		const rows: Row[] = [
			[
				{ path: "props.title", labelKey: "k.title", type: "text", value: "hello" },
				{ path: "props.color", labelKey: "k.color", type: "color", value: "#12ab34" },
			],
			[
				{
					path: "props.steps",
					labelKey: "k.steps",
					type: "number",
					value: 42,
					min: 1,
					max: 100,
					step: 5,
				},
				{
					path: "props.mode",
					labelKey: "k.mode",
					type: "select",
					value: "b",
					options: [
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
					],
				},
			],
			[{ path: "props.on", labelKey: "k.on", type: "checkbox", value: true }],
		];
		const { root } = mount(fresh(), rows);

		const text = root.querySelector('input[type="text"]') as HTMLInputElement | null;
		expect(text?.value).toBe("hello");

		const color = root.querySelector('input[type="color"]') as HTMLInputElement | null;
		expect(color?.value).toBe("#12ab34");

		const num = root.querySelector('input[type="number"]') as HTMLInputElement;
		expect(num.value).toBe("42");
		expect(num.min).toBe("1");
		expect(num.max).toBe("100");
		expect(num.step).toBe("5");

		const sel = root.querySelector("select") as HTMLSelectElement;
		expect(sel.value).toBe("b");
		expect(
			[...sel.options].map((o) => [o.value, o.textContent]).flat(),
		).toEqual(["a", "A", "b", "B"]);

		const chk = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(chk.checked).toBe(true);
	});

	test("labels resolve through t (key verbatim without a catalog)", () => {
		const { root } = mount(fresh(), [
			[{ path: "props.a", labelKey: "overlay.some_label", type: "text", value: "" }],
		]);
		expect(root.querySelector(".ov-lbl")?.textContent).toBe("overlay.some_label");
	});
});

describe("bindableForm: isBindable gating", () => {
	test("chain toggle on text/number/color — never on select/checkbox", () => {
		const rows: Row[] = [
			[
				{ path: "props.t", labelKey: "k.t", type: "text", value: "" },
				{ path: "props.n", labelKey: "k.n", type: "number", value: 0 },
				{ path: "props.c", labelKey: "k.c", type: "color", value: "#fff" },
			],
			[
				{
					path: "props.s",
					labelKey: "k.s",
					type: "select",
					value: "a",
					options: [{ value: "a", label: "A" }],
				},
				{ path: "props.b", labelKey: "k.b", type: "checkbox", value: false },
			],
		];
		const { root } = mount(fresh(), rows);
		const fields = [...root.querySelectorAll(".ov-field")];
		expect(fields.length).toBe(5);
		const toggles = fields.map((f) => f.querySelectorAll(".ov-bind-chk").length);
		expect(toggles).toEqual([1, 1, 1, 0, 0]);
	});

	test("a raw Vnode row renders verbatim and gains no toggle", () => {
		const rows: Row[] = [
			[
				{ path: "props.t", labelKey: "k.t", type: "text", value: "" },
			],
			vnode("div", { class: "custom-widget" }, "hello-widget"),
		];
		const { root } = mount(fresh(), rows);
		const widget = root.querySelector(".custom-widget");
		expect(widget?.textContent).toBe("hello-widget");
		expect(root.querySelectorAll(".ov-bind-chk").length).toBe(1);
		expect(root.querySelectorAll(".ov-field").length).toBe(1);
	});
});

describe("bindableForm: layout", () => {
	test("1 field → bare, 2 → ov-grid2, 3 → ov-grid3", () => {
		const rows: Row[] = [
			[{ path: "props.a", labelKey: "k.a", type: "text", value: "" }],
			[
				{ path: "props.b", labelKey: "k.b", type: "text", value: "" },
				{ path: "props.c", labelKey: "k.c", type: "text", value: "" },
			],
			[
				{ path: "props.d", labelKey: "k.d", type: "text", value: "" },
				{ path: "props.e", labelKey: "k.e", type: "text", value: "" },
				{ path: "props.f", labelKey: "k.f", type: "text", value: "" },
			],
		];
		const { root } = mount(fresh(), rows);
		expect(root.querySelector(".ov-grid2")?.children.length).toBe(2);
		expect(root.querySelector(".ov-grid3")?.children.length).toBe(3);
		// the single-field row is the bare .ov-field right under the fragment
		const bare = root.querySelector(".ov-field");
		expect(bare?.parentElement?.classList.contains("ov-grid2")).toBe(false);
		expect(bare?.parentElement?.classList.contains("ov-grid3")).toBe(false);
	});
});

describe("bindableForm: binding affordance", () => {
	test("chain click opens the picker; choosing a variable writes the binding", async () => {
		const el = fresh();
		const { root } = mount(el, [
			[{ path: "props.title", labelKey: "k.title", type: "text", value: "x" }],
		], [VAR]);

		const toggle = root.querySelector(".ov-bind-chk") as HTMLButtonElement;
		expect(root.querySelector(".ov-var-sel")).toBeNull();

		click(toggle);
		await until(() => root.querySelector(".ov-var-sel") !== null);
		expect(el.bindings["props.title"]).toBeUndefined();

		const picker = root.querySelector(".ov-var-sel") as HTMLSelectElement;
		expect([...picker.options].some((o) => o.value === "v-1")).toBe(true);

		changeEl(picker, "v-1");
		await until(() => el.bindings["props.title"] !== undefined);
		expect(el.bindings["props.title"]).toEqual({
			kind: "variable",
			variableId: "v-1",
		});

		// the bound field keeps the picker open and the chain lit
		await until(() =>
			(root.querySelector(".ov-bind-chk") as HTMLButtonElement).classList.contains("on"),
		);
	});

	test("a bound chain unbinds on click", async () => {
		const el = fresh();
		el.bindings["props.title"] = { kind: "variable", variableId: VAR.id };
		const { root } = mount(el, [
			[{ path: "props.title", labelKey: "k.title", type: "text", value: "x" }],
		], [VAR]);

		const toggle = root.querySelector(".ov-bind-chk") as HTMLButtonElement;
		expect(toggle.classList.contains("on")).toBe(true);

		click(toggle);
		await until(() => el.bindings["props.title"] === undefined);
	});

	test("select/checkbox rows expose no picker, so nothing to bind", () => {
		const el = fresh();
		const { root } = mount(el, [
			[
				{
					path: "props.s",
					labelKey: "k.s",
					type: "select",
					value: "a",
					options: [{ value: "a", label: "A" }],
				},
				{ path: "props.b", labelKey: "k.b", type: "checkbox", value: false },
			],
		], [VAR]);
		expect(root.querySelectorAll(".ov-bind-chk").length).toBe(0);
		expect(root.querySelectorAll(".ov-var-sel").length).toBe(0);
	});

	test("variableUrl exposes the copy button only once bound", async () => {
		const el = fresh();
		const root = getRoot();
		const mutate: Mutate = (fn) => {
			fn(el);
			void mithril.redraw();
		};
		mithril.mount(root, {
			view: () =>
				bindableForm({
					element: el,
					mutate,
					variables: [VAR],
					variableUrl: () => "https://x/?token=1&title=",
					rows: [[{ path: "props.title", labelKey: "k.title", type: "text", value: "x" }]],
				}) as Vnode,
		});

		expect(root.querySelector(".ov-bind-copy")).toBeNull();
		el.bindings["props.title"] = { kind: "variable", variableId: VAR.id };
		void mithril.redraw();
		await until(() => root.querySelector(".ov-bind-copy") !== null);
	});
});

describe("bindableForm: value round-trips", () => {
	test("number input writes a Number, checkbox writes a boolean, text/select write strings", () => {
		const el = fresh({});
		const rows: Row[] = [
			[
				{ path: "props.n", labelKey: "k.n", type: "number", value: 3 },
				{ path: "props.b", labelKey: "k.b", type: "checkbox", value: false },
			],
			[
				{ path: "props.s", labelKey: "k.s", type: "select", value: "a", options: [{ value: "a", label: "A" }, { value: "c", label: "C" }] },
				{ path: "props.t", labelKey: "k.t", type: "text", value: "" },
			],
		];
		const { root } = mount(el, rows);

		const num = root.querySelector('input[type="number"]') as HTMLInputElement;
		input(num, "3.14");
		expect(el.props.n).toBe(3.14);
		expect(typeof el.props.n).toBe("number");

		const chk = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
		chk.checked = true;
		chk.dispatchEvent(new win.Event("change", { bubbles: true }));
		expect(el.props.b).toBe(true);

		const sel = root.querySelector("select") as HTMLSelectElement;
		changeEl(sel, "c");
		expect(el.props.s).toBe("c");

		const text = root.querySelector('input[type="text"]') as HTMLInputElement;
		input(text, "hi");
		expect(el.props.t).toBe("hi");
	});

	test("the control reads its value from the descriptor at build time", async () => {
		// A fresh descriptor per build -> the control must carry `value`.
		// (The real editor re-mounts the form from the element's current
		// props on selection; a value-only mutation keeps the same vnode
		// and Mithril correctly skips the re-render, so it is not
		// assertable in a fixed mount.)
		const el = fresh({ n: 7 });
		const root = getRoot();
		const mutate: Mutate = (fn) => {
			fn(el);
			void mithril.redraw();
		};
		mithril.mount(root, {
			view: () =>
				bindableForm({
					element: el,
					mutate,
					variables: [],
					rows: [
						[{ path: "props.n", labelKey: "k.n", type: "number", value: el.props.n as number }],
					],
				}) as Vnode,
		});
		const num = root.querySelector('input[type="number"]') as HTMLInputElement;
		await until(() => Number(num.value) === 7);
	});
});
