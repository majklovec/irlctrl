/*
 * `constellation` — slow-drifting stars that twinkle and link to their
 * nearest neighbours with faint lines, like a night-sky star map.
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

const STAR_COUNT = 90;
const BASE_SPEED = 0.1;
const RANGE_SPEED = 0.5;
const BASE_TTL = 300;
const RANGE_TTL = 400;
const BASE_SIZE = 1;
const RANGE_SIZE = 2.5;
const BASE_HUE = 200;
const RANGE_HUE = 40;
/** Max distance below which two stars get linked, scaled to the box. */
const LINK_FRACTION = 0.16;

/** A single additive blur pass for the star glow. */
const GLOW_PASSES: readonly GlowPass[] = [
    { filter: "blur(4px)", lighter: true },
];

/** Star property stride: x, y, vx, vy, life, ttl, size, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_SIZE = 6;
const P_HUE = 7;

export class Constellation extends AmbientVariant {
    readonly id = "constellation";
    readonly labelKey = "overlay.ambient_constellation";

    start(env: AmbientEnv, opts: AmbientOptions): () => void {
        const stars = new ParticlePool(STAR_COUNT, 8);
        const linkDistance = Math.min(env.width, env.height) * LINK_FRACTION;
        let tick = 0;

        function initStar(i: number): void {
            const x = rand(env.width);
            const y = rand(env.height);
            const theta = rand(TAU);
            const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
            const vx = speed * Math.cos(theta);
            const vy = speed * Math.sin(theta);
            // Stagger lifetimes so the field never resets in one go.
            const ttl = BASE_TTL + rand(RANGE_TTL);
            const life = rand(ttl);
            const size = BASE_SIZE + rand(RANGE_SIZE);
            const hue = BASE_HUE + rand(RANGE_HUE);
            stars.store(i, [x, y, vx, vy, life, ttl, size, hue]);
        }

        function drawStar(i: number): void {
            const x = stars.at(i, P_X);
            const y = stars.at(i, P_Y);
            const life = stars.at(i, P_LIFE);
            const ttl = stars.at(i, P_TTL);
            const size = stars.at(i, P_SIZE);
            const hue = stars.at(i, P_HUE);
            // Twinkle: a per-star sine wave on top of the life fade-in/out.
            const twinkle = 0.55 + 0.45 * Math.sin(tick * 0.05 + i);
            withSaved(env.aw, () => {
                env.aw.fillStyle = hsla(
                    hue,
                    60,
                    75,
                    fadeInOut(life, ttl) * twinkle,
                );
                env.aw.beginPath();
                env.aw.arc(x, y, size, 0, TAU);
                env.aw.fill();
                env.aw.closePath();
            });
        }

        function updateStar(i: number): void {
            drawStar(i);
            const x2 = stars.at(i, P_X) + stars.at(i, P_VX);
            const y2 = stars.at(i, P_Y) + stars.at(i, P_VY);
            const life = stars.at(i, P_LIFE) + 1;
            // Wrap to the opposite edge so the field never thins out.
            const wx = x2 < 0 ? env.width : x2 > env.width ? 0 : x2;
            const wy = y2 < 0 ? env.height : y2 > env.height ? 0 : y2;
            stars.set(i, P_X, wx);
            stars.set(i, P_Y, wy);
            stars.set(i, P_LIFE, life);
            if (life > stars.at(i, P_TTL)) initStar(i);
        }

        function drawLinks(): void {
            // Connect each star to closer neighbours (i<j to draw once).
            stars.each((i) => {
                const ax = stars.at(i, P_X);
                const ay = stars.at(i, P_Y);
                const ahue = stars.at(i, P_HUE);
                const alife = stars.at(i, P_LIFE);
                const attl = stars.at(i, P_TTL);
                stars.each((j) => {
                    if (j <= i) return;
                    const dx = ax - stars.at(j, P_X);
                    const dy = ay - stars.at(j, P_Y);
                    const dist = Math.hypot(dx, dy);
                    if (dist > linkDistance) return;
                    const jlife = stars.at(j, P_LIFE);
                    const jttl = stars.at(j, P_TTL);
                    // Brighter when close and when both stars are in their life mid.
                    const closeness = 1 - dist / linkDistance;
                    const alpha =
                        0.25 *
                        closeness *
                        fadeInOut(alife, attl) *
                        fadeInOut(jlife, jttl);
                    withSaved(env.aw, () => {
                        env.aw.strokeStyle = hsla(ahue, 60, 70, alpha);
                        env.aw.lineWidth = 1;
                        env.aw.beginPath();
                        env.aw.moveTo(ax, ay);
                        env.aw.lineTo(stars.at(j, P_X), stars.at(j, P_Y));
                        env.aw.stroke();
                        env.aw.closePath();
                    });
                });
            });
        }

        stars.each(initStar);

        return createFrameLoop(() => {
            tick++;
            // Fade the offscreen layer toward transparent so links and star
            // trails dissolve out (never a full clear, the drawing stops never).
            beginFrame(env, opts);
            drawLinks();
            stars.each(updateStar);
            compositeGlow(env, GLOW_PASSES);
        });
    }
}
