# Ambient backgrounds

Animated canvas backgrounds for the `ambient` overlay element. Each background
is a **self-contained class** in its own file; the element, the edit form and
server-side normalization all derive from the single `AMBIENT_VARIANTS`
catalog in [`index.ts`](./index.ts), so **adding a background is a class file
- one `new` entry + one i18n label** — nothing else in the element changes.

## How it works

Every background uses the same **two-canvas** technique:
- `env.a` / `env.aw` — an _offscreen_ canvas the background paints its raw
  shapes into.
- `env.b` / `env.bw` — the _visible_ canvas the element owns. Each frame the
  background composites `a` onto the solid `opts.background`, usually through
  one or more blurred `lighter` (additive) passes to get the glow.

The trail effect comes from [`fadeCanvas`](./utils.ts): each frame it fades the
offscreen layer a little toward transparent _instead of clearing it_, so old
strokes linger and dissolve. `trailFade(opts.trail)` turns the `1–10` trail
multiplier into a per-frame fade.

The shared scaffolding lives in the engine ([`engine.ts`](./engine.ts)):

| Symbol             | Role                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `AmbientVariant`   | The abstract base class every background extends.                     |
| `AmbientEnv`       | The canvases + `width`/`height` handed to `start`.                    |
| `AmbientOptions`   | The element-resolved props: `speed`, `trail`, `background`, `custom`. |
| `createAmbientEnv` | Creates/sizes the canvas pair (used by the element).                  |
| `createFrameLoop`  | Runs your `step` once per rAF frame and returns a `stop()` function.  |
| `beginFrame`       | Start of a frame: fade `a` + paint `b`'s solid background.            |
| `compositeGlow`    | Composite `a` onto `b`, once per `GlowPass` (the blurred glow).       |
| `GlowPass`         | `{ filter?, lighter? }` — describes one composite pass.               |
| `withSaved`        | Run a draw in a saved/restored context (use for transforms).          |

Particles are a typed `Float32Array` wrapped by [`ParticlePool`](./pool.ts),
which trades the raw `i + P_F` index math for `pool.at(i, P_F)`,
`pool.set(i, P_F, v)`, `pool.store(i, [...])` and `pool.each(fn)`. The `P_*`
constants stay as named field ordinals (the pool's stride is their max + 1).

Reusable math (noise, `rand`, `lerp`, `hsla`, `fadeCanvas`, …) is in
[`utils.ts`](./utils.ts). Keep new backgrounds dependency-free and built from
these.

## Step by step

### 1. Create the class file

Add `<name>.ts` alongside the others and model it on a simple existing one
([`aurora.ts`](./aurora.ts) has no custom props; [`pipeline.ts`](./pipeline.ts)
does). The minimum contract is `id`, `labelKey`, and `start`:

```ts
import {
	AmbientVariant,
	type AmbientEnv,
	type AmbientOptions,
	beginFrame,
	compositeGlow,
	type GlowPass,
	createFrameLoop,
	withSaved,
} from "./engine";
import { ParticlePool } from "./pool";
import { fadeInOut, hsla, rand } from "./utils";

const DOT_COUNT = 100;

/** The composite look, declared once: an additive blur, then a crisp blit. */
const GLOW_PASSES: readonly GlowPass[] = [
	{ filter: "blur(6px)", lighter: true },
	{},
];

/** Field ordinals: x, y, speed, hue, life. */
const P_X = 0;
const P_Y = 1;
const P_SPEED = 2;
const P_HUE = 3;
const P_LIFE = 4;

export class NeonRain extends AmbientVariant {
	readonly id = "neon_rain";
	readonly labelKey = "overlay.ambient_neon_rain";

	start(env: AmbientEnv, opts: AmbientOptions): () => void {
		// stride = max ordinal + 1.
		const dots = new ParticlePool(DOT_COUNT, 5);

		function initDot(i: number): void {
			const x = rand(env.width);
			const y = rand(env.height);
			const speed = (1 + rand(4)) * opts.speed;
			const hue = 180 + rand(60);
			dots.store(i, [x, y, speed, hue, 0]);
		}

		function updateDot(i: number): void {
			const x = dots.at(i, P_X);
			const y = dots.at(i, P_Y);
			const speed = dots.at(i, P_SPEED);
			const hue = dots.at(i, P_HUE);
			const life = dots.at(i, P_LIFE);
			withSaved(env.aw, () => {
				env.aw.strokeStyle = hsla(hue, 100, 60, fadeInOut(life, 120) * 0.5);
				env.aw.lineWidth = 2;
				env.aw.beginPath();
				env.aw.moveTo(x, y);
				env.aw.lineTo(x, y + 12);
				env.aw.stroke();
				env.aw.closePath();
			});
			dots.set(i, P_Y, y + speed);
			dots.set(i, P_LIFE, life + 1);
			if (y + speed > env.height + 12) initDot(i);
		}

		dots.each(initDot);

		return createFrameLoop(() => {
			beginFrame(env, opts);
			dots.each(updateDot);
			compositeGlow(env, GLOW_PASSES);
		});
	}
}
```

All animation-internal state (positions, timers, the noise instance) lives in
`start`'s closure — **not** as class fields — so several instances of the same
variant can run side by side without sharing state.

### 2. Register it

Add the import and one `new` entry to `AMBIENT_VARIANTS` in
[`index.ts`](./index.ts). The order there is the order of the edit-form
dropdown. The `id`, the `kind` **select options**, the `AMBIENT_VARIANT_IDS`
validation list and `validate()` all derive from this array automatically.

```ts
import { NeonRain } from "./neon_rain";
// …
export const AMBIENT_VARIANTS: readonly AmbientVariant[] = [
	// …existing entries…
	new NeonRain(),
];
```

### 3. Add the label key + sync

Add one key to the module catalog
[`i18n/en.json`](../../i18n/en.json) (the `labelKey` from above), then run the
sync to backfill the other languages with the English text:

```sh
bun scripts/i18n.ts sync
```

That's it — for a background that uses only the shared trio (`speed`/`trail`/
`background`), the class + registration + one label is the complete change.

### 4. (Optional) Give the background its own props

A variant can own extra props that the element renders, stores flat in
`element.props`, and normalizes server-side. Override the three hooks
(see [`pipeline.ts`](./pipeline.ts) for the full pattern):
- `override readonly customDefaults` — the defaults, used as the render/normalize seed.
- `override normalizeCustomProps(props, read)` — coerce to safe values (server-side).
- `override customFormRows(element)` — the dropdown's extra rows for this variant.

Then **also** add each prop name to the hard-coded `propKeys` list in
[`ambient.tsx`](../ambient.tsx) — that is the one spot that does _not_ derive
from the catalog. The element merges the stored values over `customDefaults`
and passes them to `start` as `opts.custom`.

## Rules your `start` must follow

These are enforced by [`test/ambient.test.ts`](../../../../../../../test/ambient.test.ts),
which runs **every** registered background headless for 24 frames:
- **Only stubbed canvas methods.** The headless context stub implements
  `save/restore`, `beginPath/closePath`, `moveTo/lineTo`, `arc`, `stroke/fill`,
  `fillRect/strokeRect/clearRect`, `drawImage`, `translate/rotate`,
  `createLinearGradient`, and the property setters. Do **not** call
  `ellipse`, `bezierCurveTo`, `createRadialGradient`, `scale`, etc. — they
  aren't stubbed, so the test would throw even though the browser supports
  them. (Draw circles with `arc`.)
- **Finite numbers only.** Every number passed to a geometry call must be
  finite — a `NaN`/`Infinity` (e.g. from a `0/0` or a `1 / (ttl - life)`)
  fails the test immediately.
- **It must actually draw.** Each frame path should produce at least one
  composite to `b` and one shape on `a` over the run — an all-skip background
  fails the `draws > 0` / `shape calls > 0` assertions.
- **Return a `stop`.** `createFrameLoop` gives you the canceller; return it.
  The element calls it on prop/size change and on remove.
- **Read `opts`, don't hard-code.** Use `opts.speed`, `opts.trail`,
  `opts.background` (and `opts.custom.*` if you added props) so the shared
  controls apply.

## Verifying a new background

```sh
bun test test/ambient.test.ts        # headless run of every variant + contract
bun scripts/i18n.ts check --strict   # no missing/extra keys vs en.json
```

The `every variant animates…` test loops over `AMBIENT_VARIANTS`, so a new
entry is exercised automatically the moment it's registered — no test edit
needed for a custom-prop-free background.
