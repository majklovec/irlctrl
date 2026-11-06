/*
 * `coalesce` — particles spiralling into the center.
 * Port of `coalesce.js` from crnacura/AmbientCanvasBackgrounds (CC BY-SA).
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
import { angle, fadeInOut, HALF_PI, hsla, lerp, rand } from "./utils";

const PARTICLE_COUNT = 700;
const BASE_TTL = 100;
const RANGE_TTL = 500;
const BASE_SPEED = 0.1;
const RANGE_SPEED = 1;
const BASE_SIZE = 2;
const RANGE_SIZE = 10;
const BASE_HUE = 10;
const RANGE_HUE = 100;

/** Glow composite: two blurred additive passes + one crisp pass. */
const GLOW_PASSES: readonly GlowPass[] = [
    { filter: "blur(8px) brightness(200%)", lighter: true },
    { filter: "blur(4px) brightness(200%)", lighter: true },
    { lighter: true },
];

/** Particle field ordinals: x, y, vx, vy, life, ttl, speed, size, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_SPEED = 6;
const P_SIZE = 7;
const P_HUE = 8;

export class Coalesce extends AmbientVariant {
    readonly id = "coalesce";
    readonly labelKey = "overlay.ambient_coalesce";

    start(env: AmbientEnv, opts: AmbientOptions): () => void {
        const cx = 0.5 * env.width;
        const cy = 0.5 * env.height;
        const particles = new ParticlePool(PARTICLE_COUNT, 9);

        function initParticle(i: number): void {
            const x = rand(env.width);
            const y = rand(env.height);
            const theta = angle(x, y, cx, cy);
            const vx = Math.cos(theta) * 6;
            const vy = Math.sin(theta) * 6;
            const ttl = BASE_TTL + rand(RANGE_TTL);
            const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
            const size = BASE_SIZE + rand(RANGE_SIZE);
            const hue = BASE_HUE + rand(RANGE_HUE);
            particles.store(i, [x, y, vx, vy, 0, ttl, speed, size, hue]);
        }

        function drawParticle(
            i: number,
            theta: number,
            x: number,
            y: number,
        ): void {
            const life = particles.at(i, P_LIFE);
            const ttl = particles.at(i, P_TTL);
            const size = particles.at(i, P_SIZE);
            const hue = particles.at(i, P_HUE);
            const xRel = x - 0.5 * size;
            const yRel = y - 0.5 * size;
            // This draw uses translate/rotate for the spin, so wrap it to keep
            // the transform from leaking to the next particle.
            withSaved(env.aw, () => {
                env.aw.lineCap = "round";
                env.aw.lineWidth = 1;
                env.aw.strokeStyle = hsla(hue, 100, 60, fadeInOut(life, ttl));
                env.aw.beginPath();
                env.aw.translate(xRel, yRel);
                env.aw.rotate(theta);
                env.aw.translate(-xRel, -yRel);
                env.aw.strokeRect(xRel, yRel, size, size);
                env.aw.closePath();
            });
        }

        function updateParticle(i: number): void {
            const x = particles.at(i, P_X);
            const y = particles.at(i, P_Y);
            const theta = angle(x, y, cx, cy) + 0.75 * HALF_PI;
            const vx = lerp(particles.at(i, P_VX), 2 * Math.cos(theta), 0.05);
            const vy = lerp(particles.at(i, P_VY), 2 * Math.sin(theta), 0.05);
            const speed = particles.at(i, P_SPEED);
            drawParticle(i, theta, x, y);
            const x2 = x + vx * speed;
            const y2 = y + vy * speed;
            const life = particles.at(i, P_LIFE) + 1;
            const ttl = particles.at(i, P_TTL);
            particles.set(i, P_X, x2);
            particles.set(i, P_Y, y2);
            particles.set(i, P_VX, vx);
            particles.set(i, P_VY, vy);
            particles.set(i, P_LIFE, life);
            if (life > ttl) initParticle(i);
        }

        particles.each(initParticle);

        return createFrameLoop(() => {
            beginFrame(env, opts);
            particles.each(updateParticle);
            compositeGlow(env, GLOW_PASSES);
        });
    }
}
