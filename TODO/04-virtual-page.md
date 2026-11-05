# Handoff: Server‑Only Virtual Page Rendering Refactor

**Repo:** https://github.com/majklovec/irlctrl
**Scope:** Server‑side only. `client/**` (all `.tsx` / `.ts` source) must remain byte‑for‑byte untouched.
**Author of brief:** (you) — refining a previous proposal after feedback.
**For:** an AI coding agent that will execute the refactor.

---

## 1. Goal

Remove all static HTML shell files that are currently used as page entry points, and instead **generate the HTML virtually on the server** at request time. The URL routes must stay identical. The Mithril `.tsx` entry points referenced by those HTML shells must stay exactly where they are and be loaded unchanged.

Mechanism to achieve this:
- A **server‑side page registry** where pages register themselves.
- Only the three **core pages** (`index`, `settings`, `setup`) are preregistered.
- Every other page (module‑owned pages, dashboards, overlays, device pages, etc.) calls `registerPage(...)` from **its server‑side module entry point**.
- The build pipeline bundles the `.tsx` entry points reported by the registry (not HTML files).
- A single `renderPage(name)` function produces the HTML response from a fixed template + per‑page metadata.

---

## 2. Hard constraints

1. **Do not modify anything under `client/`.** This includes moving, renaming, refactoring, or reformatting any `.tsx` / `.ts` file. The `.tsx` entry points must be referenced by path exactly as they are today.
2. **Do not change public URL routes.** `/`, `/settings`, `/setup`, `/d/:id`, `/dashboards`, `/overlays`, etc. must resolve to the same page names as today.
3. **Do not change the HTML shell semantics.** The generated HTML must contain the same `<meta>` tags, the same service‑worker registration snippet, the same manifest link, and the same `#app` mount point that the current HTML shells have.
4. **Only delete `.html` files that are pure shells** (they contain only `<head>` boilerplate, `<div id="app"></div>`, and one `<script type="module" src="…tsx">`). If any `.html` file contains meaningful markup, stop and flag it in the PR description — do not silently drop it.
5. **Server files only** may be added, modified, or deleted (plus removal of the `.html` shells as described above).

---

## 3. Current state (what to expect)

- Every page lives as a static `.html` file, e.g.:
  - Core: `client/frontend/pages/index.html`, `settings.html`, `setup.html`
  - Module‑owned: `*/pages/*.html` (e.g. `dashboards/pages/index.html`)
- Each HTML file is a **near‑identical template**:
  - same `<head>` boilerplate
  - same `<link rel="stylesheet" href="…/shared/css/style.css">`
  - same `<link rel="manifest" href="…/shared/assets/pwa/manifest.webmanifest">`
  - same `<div id="app"></div>`
  - same inline service‑worker registration snippet
  - **one** `<script type="module" src="…/entry.tsx">` — the only page‑specific part
- `shared/frontend.ts` (or similar) has a helper (referred to below as `frontendPageEntries`) that scans for `**/pages/*.html` and passes them as entry points to `Bun.build`.
- Server routes call a helper such as `htmlResponse(pageName)` to return the prebuilt HTML string for that page.
- The build compiles HTML files, so the emitted `index.html`, `settings.html`, … are the served responses.

---

## 4. Target architecture

### 4.1 Page definition type

Create `server/pages/types.ts`:

```ts
export interface PageDefinition {
	/** Route/page key. Must match the name used by the router (e.g. "index", "settings", "dashboards"). */
	name: string;

	/** Value for <title>. */
	title: string;

	/**
	 * Path to the .tsx entry point, relative to the repo root.
	 * This is the SAME path that is currently referenced by the corresponding .html file.
	 * Do NOT move or rename the .tsx file.
	 */
	entry: string;

	/** Optional extra CSS files, relative to the public root (e.g. "shared/css/style.css"). */
	assets?: string[];

	/** Optional extra HTML injected into <head> before </head>. Rare — prefer `assets`. */
	head?: string;
}
```

### 4.2 Registry

Create `server/pages/registry.ts`:

```ts
import type { PageDefinition } from "./types";

const registry = new Map<string, PageDefinition>();

export function registerPage(def: PageDefinition): void {
	if (registry.has(def.name)) {
		throw new Error(`Page "${def.name}" is already registered`);
	}
	registry.set(def.name, def);
}

export function getPage(name: string): PageDefinition | undefined {
	return registry.get(name);
}

export function hasPage(name: string): boolean {
	return registry.has(name);
}

export function listPages(): PageDefinition[] {
	return [...registry.values()];
}
```

### 4.3 Core page preregistration

Create `server/pages/core.ts`:

```ts
import { registerPage } from "./registry";

registerPage({
	name: "index",
	title: "IRLCTRL control",
	entry: "client/frontend/ts/index.tsx", // ← use the exact .tsx path from the deleted index.html
	assets: ["shared/css/style.css"],
});

registerPage({
	name: "settings",
	title: "Settings – IRLCTRL",
	entry: "client/frontend/ts/settings.tsx",
	assets: ["shared/css/style.css"],
});

registerPage({
	name: "setup",
	title: "Setup – IRLCTRL",
	entry: "client/frontend/ts/setup.tsx",
	assets: ["shared/css/style.css"],
});
```

> ⚠️ The `entry` values above are illustrative. Read each deleted `.html` file’s `<script type="module" src="…">` to get the exact `.tsx` path, and plug those values in verbatim. Do not guess.

Import `./core` once, at the top of the server entry module (control server AND device server), before any module registration runs.

### 4.4 Self‑registration for module pages

Every module that currently ships a `pages/*.html` shell must now register its page from its **server‑side entry point** (e.g. `server/module.ts`, `*.server.ts`, or wherever the module boots on the server — find the existing server module registration and hook in there).

```ts
import { registerPage } from "../../server/pages/registry";

registerPage({
	name: "dashboards",
	title: "Dashboards – IRLCTRL",
	entry: "client/modules/dashboards/frontend/index.tsx",
	assets: ["shared/css/style.css"],
});
```

If a module has multiple pages, it calls `registerPage` once per page. If a module has no server entry point today, add one **only if it is a new file** (do not modify existing client files). If adding a new server file per module is not viable, see “Fallback” below.

**Fallback (only if a module truly has no server hook to run registration from):**
Change `frontendPageEntries` (or equivalent scan) to scan for `**/pages/*.tsx` _entry_ files instead of `*.html`, and auto‑register them with a convention (`name = filename without extension`, `title = name`). This stays server‑side. Prefer explicit `registerPage` when a server hook exists.

### 4.5 Renderer

Create `server/pages/render.ts`:

```ts
import { getPage } from "./registry";

// Populated after the Bun.build pass by walking the build output.
export const pageAssetMap = new Map<string, string>(); // pageName → emitted entry filename (e.g. "index-abc123.js")

export function renderPage(name: string): Response {
	const page = getPage(name);
	if (!page) {
		return new Response(`Unknown page: ${name}`, { status: 404 });
	}

	const emitted = pageAssetMap.get(name);
	if (!emitted) {
		return new Response(`Page not built: ${name}`, { status: 500 });
	}

	const assetLinks = (page.assets ?? [])
		.map((a) => `<link rel="stylesheet" href="/${a}" />`)
		.join("\n  ");

	const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${page.title}</title>
  ${assetLinks}
  <link rel="manifest" href="/shared/assets/pwa/manifest.webmanifest" />
  <meta name="theme-color" content="#0b0d12" />
  ${page.head ?? ""}
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/${emitted}"></script>
  <script>
    if ("serviceWorker" in navigator)
      addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  </script>
</body>
</html>`;

	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-cache",
		},
	});
}
```

> The template above is deliberately identical to the current HTML shell (same `<meta>`, same SW snippet, same `#app` div). Any deviation here is a regression — keep the string byte‑identical except for `<title>` and the per‑page `<script>`/asset links.

### 4.6 Build pipeline

Modify `shared/frontend.ts` (or wherever the `Bun.build` call lives):
- Replace `frontendPageEntries()` (which returns `.html` paths) with `listPages().map((p) => p.entry)`.
- After `Bun.build` resolves, iterate `listPages()` and match each page’s `entry` to the corresponding emitted output filename, then write into `pageAssetMap`:

```ts
import { listPages } from "../server/pages/registry";
import { pageAssetMap } from "../server/pages/render";

const pages = listPages();

const result = await Bun.build({
	entrypoints: pages.map((p) => p.entry),
	target: "browser",
	minify: true,
	splitting: true,
	publicPath: "/assets/",
	naming: {
		/* keep existing naming */
	},
});

for (const output of result.outputs) {
	const match = pages.find(
		(p) =>
			output.path.endsWith(path.basename(p.entry).replace(/\.tsx?$/, "")) ||
			(output.kind === "entry-point" &&
				output.path.includes(/* entry basename */)),
	);
	// robust version: build a Map<absolute entry path, pageName> once, then look up output.path.
}
```

The exact matching logic depends on how Bun reports entry outputs. Suggested robust form:

```ts
const entryToPage = new Map(pages.map((p) => [p.entry, p.name]));
for (const output of result.outputs) {
	if (output.kind !== "entry-point") continue;
	const rel = path.relative(process.cwd(), output.path);
	// Bun keeps the entry’s base name — resolve it via the original entry list.
	const matched = pages.find((p) =>
		path
			.basename(rel)
			.startsWith(path.basename(p.entry).replace(/\.tsx?$/, "")),
	);
	if (matched) pageAssetMap.set(matched.name, path.basename(rel));
}
```

Verify this against actual build output — do not ship without running a build and inspecting `result.outputs`.

### 4.7 Server routes

In every server route file that currently calls `htmlResponse(pageName)`, replace with `renderPage(pageName)`. Both the control server and the device server.

Examples (adapt to actual code):

```ts
// before
app.get("/", () => htmlResponse("index"));
app.get("/settings", () => htmlResponse("settings"));

// after
app.get("/", () => renderPage("index"));
app.get("/settings", () => renderPage("settings"));
```

Keep every URL pattern and route name exactly the same.

If there are 404 fallbacks that serve `htmlResponse("index")` (SPA fallback), change them to `renderPage("index")` as well.

### 4.8 Delete the HTML shells

After the registry, renderer, build, and routes are in place, delete:
- `client/frontend/pages/index.html`
- `client/frontend/pages/settings.html`
- `client/frontend/pages/setup.html`
- Every `*/pages/*.html` that is a pure shell.

Before deleting each one, copy its `<script type="module" src="…">` path into the corresponding `registerPage({ entry: … })` call. The `.tsx` targets must remain untouched.

Delete `frontendPageEntries()` and any related HTML‑entry logic that’s now dead.

---

## 5. Ordered task list

1. Read every `*/pages/*.html` and record (page name, title, entry `.tsx` path) — this is the ground truth for registration values.
2. Create `server/pages/types.ts`, `server/pages/registry.ts`, `server/pages/core.ts`, `server/pages/render.ts`.
3. Wire `import "./core"` into both server entries (control + device) so core pages are preregistered before module boot.
4. For each module with a `pages/*.html`: add a `registerPage(...)` call in the module’s **server‑side** entry (create a new server file only if needed; never edit `client/**`).
5. Rewrite the build step in `shared/frontend.ts` to use `listPages()` entries and populate `pageAssetMap`.
6. Replace every `htmlResponse(...)` call site with `renderPage(...)`.
7. Delete all pure‑shell `.html` files.
8. Remove `frontendPageEntries()` and any dead HTML‑scanning code.
9. Run a full build, start both servers, and walk §6 below.

---

## 6. Verification checklist

For **every** existing route:
- [ ] HTTP 200 and `content-type: text/html; charset=utf-8`.
- [ ] `<title>` matches the previous static page’s title.
- [ ] `<link rel="stylesheet" href="/shared/css/style.css">` (or the exact previous href) present.
- [ ] `<link rel="manifest" href="/shared/assets/pwa/manifest.webmanifest">` present.
- [ ] `<meta name="theme-color" content="#0b0d12">` present.
- [ ] `<div id="app"></div>` present.
- [ ] `<script type="module" src="/assets/<emitted-entry>.js">` resolves with 200 (open DevTools → Network).
- [ ] The correct Mithril component mounts in `#app` (no console errors, no white screen).
- [ ] Service worker registers (Application → Service Workers in DevTools shows active).
- [ ] After registering the SW and reloading, offline navigation to cached routes still works.

Global checks:
- [ ] `bun build` / `bun run build` exits 0 and emits one JS entry per page in `listPages()`.
- [ ] No route returns "Unknown page" or "Page not built" in normal operation.
- [ ] `/sw.js`, PWA manifest, and static assets still serve 200.
- [ ] `git diff --name-only client/` shows **zero** changes to `.ts` / `.tsx` files (only deletions of `.html` shells if the reviewer allows them under `client/` — if not, keep them in place but unused; flag this to the reviewer).
- [ ] `git diff --name-only` shows only files under `server/`, `shared/`, and the deleted `.html` shells.

---

## 7. Rollback

The refactor is additive until step 7. If verification fails:
- Revert step 7 (restore `.html` files) and step 6 (restore `htmlResponse` calls). The new registry/renderer files are inert if nothing imports them.
- Do not delete the shells until steps 1–6 pass the verification checklist against a staging server.

---

## 8. Gotchas / open questions to resolve against the actual repo

1. **Entry path convention** — the exact `<script src>` in each HTML shell is the source of truth. Do not assume `index.tsx` vs `index.ts`. Read each one.
2. **Build output naming** — Bun’s `naming` config may or may not produce hashed filenames. If hashed, `pageAssetMap` is mandatory (as designed). If not hashed, `renderPage` can use `${page.name}.js` directly, but keep `pageAssetMap` for safety.
3. **`sw.js` path** — some HTML shells may register a scope‑specific SW. Preserve whatever each shell does; if all shells are identical, the template’s hard‑coded snippet is fine.
4. **`frontendPageEntries` may be used elsewhere** (tests, dev scripts, CI). Grep before deleting.
5. **Device server vs control server** — both may serve pages. Both must be updated to call `renderPage`. If they share a route helper, one change covers both.
6. **Module frontend already has a registration mechanism** — check whether modules already expose a `frontend` object server‑side; if so, hang `registerPage(...)` off that existing hook instead of introducing new files.
7. **Assets list per page** — do not over‑generalize. Most pages only need `shared/css/style.css`. If a shell also loads page‑specific CSS, add it to `assets`.
8. **If a shell is not a pure shell** — stop and open a discussion in the PR. Do not delete or silently inline it.

---

## 9. Deliverables in the PR

- New files under `server/pages/` (`types.ts`, `registry.ts`, `core.ts`, `render.ts`).
- Modified `shared/frontend.ts` (build pipeline).
- Modified server route files (control + device).
- New `registerPage(...)` calls per module, placed in **server‑side** module entries.
- Deleted `**/pages/*.html` shells.
- Filled‑in verification checklist (copy §6 into the PR body and tick every box with evidence: status codes, DevTools screenshots, `git diff --name-only client/` output).

If any step is impossible without touching `client/**`, stop and report it in the PR rather than making the change.
