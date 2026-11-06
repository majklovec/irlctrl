/*
 * `bubbles` — round bubbles of varying size rising from the bottom, swaying
 * gently as they drift up, popping at the top.
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

const BUBBLE_COUNT = 80;
const BASE_SPEED = 0.4;
const RANGE_SPEED = 1.2;
const BASE_TTL = 200;
const RANGE_TTL = 300;
const BASE_RADIUS = 4;
const RANGE_RADIUS = 22;
const BASE_HUE = 180;
const RANGE_HUE = 40;
/** Horizontal sway amplitude (px) and angular frequency for each bubble. */
const SWAY_BASE = 12;
const SWAY_RANGE = 20;
const SWAY_FREQ_BASE = 0.02;
const SWAY_FREQ_RANGE = 0.03;

/** Composite passes: an additive blur underlayer, then a crisp blit. */
const GLOW_PASSES: readonly GlowPass[] = [
    { filter: "blur(6px)", lighter: true },
    {},
];

/** Bubble property stride: x, y, vy, life, ttl, radius, hue, swayAmp,
 * swayFreq, phase. */
const P_X = 0;
const P_Y = 1;
const P_VY = 2;
const P_LIFE = 3;
const P_TTL = 4;
const P_RADIUS = 5;
const P_HUE = 6;
const P_SWAY_AMP = 7;
const P_SWAY_FREQ = 8;
const P_PHASE = 9;

export class Bubbles extends AmbientVariant {
    readonly id = "bubbles";
    readonly labelKey = "overlay.ambient_bubbles";

    start(env: AmbientEnv, opts: AmbientOptions): () => void {
        const bubbles = new ParticlePool(BUBBLE_COUNT, 10);
        let tick = 0;

        function initBubble(i: number, spawnAtBottom: boolean): void {
            const x = rand(env.width);
            const y = spawnAtBottom
                ? env.height + rand(env.height * 0.3)
                : rand(env.height);
            const vy = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
            const ttl = BASE_TTL + rand(RANGE_TTL);
            const life = spawnAtBottom ? 0 : rand(ttl);
            const radius = BASE_RADIUS + rand(RANGE_RADIUS);
            const hue = BASE_HUE + rand(RANGE_HUE);
            const swayAmp = SWAY_BASE + rand(SWAY_RANGE);
            const swayFreq = SWAY_FREQ_BASE + rand(SWAY_FREQ_RANGE);
            const phase = rand(TAU);
            bubbles.store(i, [
                x,
                y,
                vy,
                life,
                ttl,
                radius,
                hue,
                swayAmp,
                swayFreq,
                phase,
            ]);
        }

        function drawBubble(i: number): void {
            const baseX = bubbles.at(i, P_X);
            const y = bubbles.at(i, P_Y);
            const life = bubbles.at(i, P_LIFE);
            const ttl = bubbles.at(i, P_TTL);
            const radius = bubbles.at(i, P_RADIUS);
            const hue = bubbles.at(i, P_HUE);
            const swayAmp = bubbles.at(i, P_SWAY_AMP);
            const swayFreq = bubbles.at(i, P_SWAY_FREQ);
            const phase = bubbles.at(i, P_PHASE);
            // Gentle horizontal sway around the base x.
            const x = baseX + Math.sin(tick * swayFreq + phase) * swayAmp;
            withSaved(env.aw, () => {
                env.aw.strokeStyle = hsla(
                    hue,
                    80,
                    65,
                    fadeInOut(life, ttl) * 0.8,
                );
                env.aw.lineWidth = 1.5;
                env.aw.beginPath();
                env.aw.arc(x, y, radius, 0, TAU);
                env.aw.stroke();
                // A faint specular highlight toward the upper-left of the bubble.
                const hx = x - radius * 0.35;
                const hy = y - radius * 0.35;
                env.aw.fillStyle = hsla(
                    hue,
                    60,
                    85,
                    fadeInOut(life, ttl) * 0.5,
                );
                env.aw.beginPath();
                env.aw.arc(hx, hy, Math.max(0.5, radius * 0.25), 0, TAU);
                env.aw.fill();
                env.aw.closePath();
            });
        }

        function updateBubble(i: number): void {
            drawBubble(i);
            const y = bubbles.at(i, P_Y) - bubbles.at(i, P_VY);
            // Keep the base x drifting a little so the column wanders.
            const x = bubbles.at(i, P_X) + (Math.random() - 0.5) * 0.2;
            const life = bubbles.at(i, P_LIFE) + 1;
            bubbles.set(i, P_X, x);
            bubbles.set(i, P_Y, y);
            bubbles.set(i, P_LIFE, life);
            const out = y < -bubbles.at(i, P_RADIUS);
            if (out || life > bubbles.at(i, P_TTL)) initBubble(i, true);
        }

        // Pre-fill the field so it is populated from the first frame.
        bubbles.each((i) => initBubble(i, false));

        return createFrameLoop(() => {
            tick++;
            // Fade the offscreen layer toward transparent so rising trails
            // dissolve out (never a full clear, the drawing never stops).
            beginFrame(env, opts);
            bubbles.each(updateBubble);
            compositeGlow(env, GLOW_PASSES);
        });
    }
}
