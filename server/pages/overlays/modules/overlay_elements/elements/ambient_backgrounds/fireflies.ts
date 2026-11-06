/*
 * `fireflies` — a swarm of warm points that hover, wander gently, and blink
 * in and out slowly, evoking fireflies drifting in the dark.
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
import { fadeInOut, hsla, lerp, rand, randRange, TAU } from "./utils";

const FIREFLY_COUNT = 120;
const BASE_TTL = 250;
const RANGE_TTL = 300;
const BASE_SPEED = 0.2;
const RANGE_SPEED = 0.8;
const BASE_RADIUS = 1.5;
const RANGE_RADIUS = 3;
const BASE_HUE = 60;
const RANGE_HUE = 40;
/** Blink period (frames) and how much of the blink cycle reads dark before
 * a firefly flares up (keeps them mostly dim, briefly bright). */
const BLINK_PERIOD_BASE = 40;
const BLINK_PERIOD_RANGE = 60;
const BLINK_DUTY = 0.5;

/** Glow pass: two blurred additive composites + a crisp additive one. */
const GLOW_PASSES: readonly GlowPass[] = [
    { filter: "blur(8px) brightness(160%)", lighter: true },
    { filter: "blur(4px) brightness(160%)", lighter: true },
    { lighter: true },
];

/** Firefly property stride: x, y, vx, vy, life, ttl, speed, radius, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_SPEED = 6;
const P_RADIUS = 7;
const P_HUE = 8;

export class Fireflies extends AmbientVariant {
    readonly id = "fireflies";
    readonly labelKey = "overlay.ambient_fireflies";

    start(env: AmbientEnv, opts: AmbientOptions): () => void {
        const fireflies = new ParticlePool(FIREFLY_COUNT, 9);
        let tick = 0;

        function initFirefly(i: number): void {
            const x = rand(env.width);
            const y = rand(env.height);
            const ttl = BASE_TTL + rand(RANGE_TTL);
            const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
            const radius = BASE_RADIUS + rand(RANGE_RADIUS);
            const hue = BASE_HUE + rand(RANGE_HUE);
            fireflies.store(i, [x, y, 0, 0, 0, ttl, speed, radius, hue]);
        }

        function drawFirefly(i: number): void {
            const x = fireflies.at(i, P_X);
            const y = fireflies.at(i, P_Y);
            const life = fireflies.at(i, P_LIFE);
            const ttl = fireflies.at(i, P_TTL);
            const radius = fireflies.at(i, P_RADIUS);
            const hue = fireflies.at(i, P_HUE);
            // Blink: each firefly has its own period/phase so the swarm glows
            // up and down unevenly rather than in lockstep.
            const period = BLINK_PERIOD_BASE + (i % BLINK_PERIOD_RANGE);
            const blink = 0.5 + 0.5 * Math.sin((tick / period) * TAU + i);
            const brightness = blink ** (1 / BLINK_DUTY) * BLINK_DUTY;
            withSaved(env.aw, () => {
                env.aw.fillStyle = hsla(
                    hue,
                    100,
                    65,
                    fadeInOut(life, ttl) * brightness,
                );
                env.aw.beginPath();
                env.aw.arc(x, y, radius, 0, TAU);
                env.aw.fill();
                env.aw.closePath();
            });
        }

        function updateFirefly(i: number): void {
            drawFirefly(i);
            // Wander: drift direction is eased toward a new random heading.
            const vx = lerp(fireflies.at(i, P_VX), randRange(1), 0.05);
            const vy = lerp(fireflies.at(i, P_VY), randRange(1), 0.05);
            const speed = fireflies.at(i, P_SPEED);
            let x = fireflies.at(i, P_X) + vx * speed;
            let y = fireflies.at(i, P_Y) + vy * speed;
            // Soft wrap at the edges.
            if (x < 0) x = env.width;
            if (x > env.width) x = 0;
            if (y < 0) y = env.height;
            if (y > env.height) y = 0;
            const life = fireflies.at(i, P_LIFE) + 1;
            fireflies.set(i, P_X, x);
            fireflies.set(i, P_Y, y);
            fireflies.set(i, P_VX, vx);
            fireflies.set(i, P_VY, vy);
            fireflies.set(i, P_LIFE, life);
            if (life > fireflies.at(i, P_TTL)) initFirefly(i);
        }

        fireflies.each(initFirefly);

        return createFrameLoop(() => {
            tick++;
            // Fade the offscreen layer toward transparent so bright blinks
            // dissolve out (never a full clear, the drawing never stops).
            beginFrame(env, opts);
            fireflies.each(updateFirefly);
            compositeGlow(env, GLOW_PASSES);
        });
    }
}
