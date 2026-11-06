/*
 * `ripple` — sonar-like rings that expand from scattering origins and fade
 * as they grow, like raindrops striking still water.
 * Original (invented for the ambient set).
 */

import {
    type AmbientEnv,
    type AmbientOptions,
    AmbientVariant,
    beginFrame,
    compositeGlow,
    createFrameLoop,
    type GlowPass,
    withSaved,
} from "./engine";
import { ParticlePool } from "./pool";
import { fadeInOut, hsla, rand, TAU } from "./utils";

const RIPPLE_COUNT = 40;
const BASE_TTL = 160;
const RANGE_TTL = 160;
/** Radius the ring has reached at end of life, scaled to the box. */
const MAX_RADIUS_FRACTION = 0.35;
const BASE_HUE = 165;
const RANGE_HUE = 40;
/** Concentric rings drawn per ripple (outermost to a couple of inner ones),
 * each a fraction of the leading ring's radius. */
const RING_FRACTIONS = [1, 0.66, 0.4];

/** Composite passes: an additive blur underlayer, then a crisp blit. */
const GLOW_PASSES: readonly GlowPass[] = [
    { filter: "blur(3px)", lighter: true },
    {},
];

/** Ripple property stride: x, y, life, ttl, expansion, width, hue. */
const P_X = 0;
const P_Y = 1;
const P_LIFE = 2;
const P_TTL = 3;
const P_EXPANSION = 4;
const P_WIDTH = 5;
const P_HUE = 6;

export class Ripple extends AmbientVariant {
    readonly id = "ripple";
    readonly labelKey = "overlay.ambient_ripple";

    start(env: AmbientEnv, opts: AmbientOptions): () => void {
        const ripples = new ParticlePool(RIPPLE_COUNT, 7);
        const maxRadius = Math.min(env.width, env.height) * MAX_RADIUS_FRACTION;

        function initRipple(i: number, stagger: boolean): void {
            const x = rand(env.width);
            const y = rand(env.height);
            const ttl = BASE_TTL + rand(RANGE_TTL);
            const life = stagger ? rand(ttl) : 0;
            // Rings must reach maxRadius by the end of their life.
            const expansion = (maxRadius / ttl) * opts.speed;
            const width = 1 + rand(2);
            const hue = BASE_HUE + rand(RANGE_HUE);
            ripples.store(i, [x, y, life, ttl, expansion, width, hue]);
        }

        function drawRipple(i: number): void {
            const x = ripples.at(i, P_X);
            const y = ripples.at(i, P_Y);
            const life = ripples.at(i, P_LIFE);
            const ttl = ripples.at(i, P_TTL);
            const expansion = ripples.at(i, P_EXPANSION);
            const width = ripples.at(i, P_WIDTH);
            const hue = ripples.at(i, P_HUE);
            const radius = life * expansion;
            if (radius < 0.5) return;
            const fade = fadeInOut(life, ttl);
            for (const f of RING_FRACTIONS) {
                const r = radius * f;
                withSaved(env.aw, () => {
                    env.aw.strokeStyle = hsla(hue, 80, 60, fade * 0.4 * f);
                    env.aw.lineWidth = width * f;
                    env.aw.beginPath();
                    env.aw.arc(x, y, r, 0, TAU);
                    env.aw.stroke();
                    env.aw.closePath();
                });
            }
        }

        function updateRipple(i: number): void {
            drawRipple(i);
            const life = ripples.at(i, P_LIFE) + 1;
            ripples.set(i, P_LIFE, life);
            if (life > ripples.at(i, P_TTL)) initRipple(i, true);
        }

        // Stagger lifetimes so ripples erupt continuously, not in unison.
        ripples.each((i) => initRipple(i, true));

        return createFrameLoop(() => {
            // Fade the offscreen layer toward transparent so old rings dissolve
            // out (never a full clear, the drawing never stops).
            beginFrame(env, opts);
            ripples.each(updateRipple);
            compositeGlow(env, GLOW_PASSES);
        });
    }
}
