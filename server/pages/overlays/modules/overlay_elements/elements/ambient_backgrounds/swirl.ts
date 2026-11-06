/*
 * `swirl` — fine particles pulled along a 3D simplex-noise flow field.
 * Port of `swirl.js` from crnacura/AmbientCanvasBackgrounds (CC BY-SA).
 */

import {
    type AmbientEnv,
    type AmbientOptions,
    AmbientVariant,
    beginFrame,
    compositeGlow,
    createFrameLoop,
    type GlowPass,
} from "./engine";
import { ParticlePool } from "./pool";
import {
    createSimplexNoise,
    fadeInOut,
    hsla,
    lerp,
    rand,
    randRange,
    type SimplexNoise3D,
    TAU,
} from "./utils";

const PARTICLE_COUNT = 700;
const RANGE_Y = 100;
const BASE_TTL = 50;
const RANGE_TTL = 150;
const BASE_SPEED = 0.1;
const RANGE_SPEED = 2;
const BASE_RADIUS = 1;
const RANGE_RADIUS = 4;
const BASE_HUE = 220;
const RANGE_HUE = 100;
const NOISE_STEPS = 8;
const X_OFF = 0.00125;
const Y_OFF = 0.00125;
const Z_OFF = 0.0005;

/** Glow composite: two blurred additive passes + one crisp pass. */
const GLOW_PASSES: readonly GlowPass[] = [
    { filter: "blur(8px) brightness(200%)", lighter: true },
    { filter: "blur(4px) brightness(200%)", lighter: true },
    { lighter: true },
];

/** Particle field ordinals: x, y, vx, vy, life, ttl, speed, radius, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_SPEED = 6;
const P_RADIUS = 7;
const P_HUE = 8;

export class Swirl extends AmbientVariant {
    readonly id = "swirl";
    readonly labelKey = "overlay.ambient_swirl";

    start(env: AmbientEnv, opts: AmbientOptions): () => void {
        // Particles spawn in a middle band that runs along the box's longer
        // axis: horizontal when the box is wider than tall, vertical otherwise.
        const horizontalBand = env.width >= env.height;
        const cx = 0.5 * env.width;
        const cy = 0.5 * env.height;
        const simplex: SimplexNoise3D = createSimplexNoise();
        const particles = new ParticlePool(PARTICLE_COUNT, 9);
        let tick = 0;

        function initParticle(i: number): void {
            const x = horizontalBand
                ? rand(env.width)
                : cx + randRange(RANGE_Y);
            const y = horizontalBand
                ? cy + randRange(RANGE_Y)
                : rand(env.height);
            const ttl = BASE_TTL + rand(RANGE_TTL);
            const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
            const radius = BASE_RADIUS + rand(RANGE_RADIUS);
            const hue = BASE_HUE + rand(RANGE_HUE);
            particles.store(i, [x, y, 0, 0, 0, ttl, speed, radius, hue]);
        }

        function drawParticle(i: number, x2: number, y2: number): void {
            const x = particles.at(i, P_X);
            const y = particles.at(i, P_Y);
            const life = particles.at(i, P_LIFE);
            const ttl = particles.at(i, P_TTL);
            const radius = particles.at(i, P_RADIUS);
            const hue = particles.at(i, P_HUE);
            env.aw.lineCap = "round";
            env.aw.lineWidth = radius;
            env.aw.strokeStyle = hsla(hue, 100, 60, fadeInOut(life, ttl));
            env.aw.beginPath();
            env.aw.moveTo(x, y);
            env.aw.lineTo(x2, y2);
            env.aw.stroke();
            env.aw.closePath();
        }

        function updateParticle(i: number): void {
            const x = particles.at(i, P_X);
            const y = particles.at(i, P_Y);
            const n =
                simplex.noise3D(x * X_OFF, y * Y_OFF, tick * Z_OFF) *
                NOISE_STEPS *
                TAU;
            const vx = lerp(particles.at(i, P_VX), Math.cos(n), 0.5);
            const vy = lerp(particles.at(i, P_VY), Math.sin(n), 0.5);
            const speed = particles.at(i, P_SPEED);
            const x2 = x + vx * speed;
            const y2 = y + vy * speed;
            drawParticle(i, x2, y2);
            const life = particles.at(i, P_LIFE) + 1;
            const ttl = particles.at(i, P_TTL);
            particles.set(i, P_X, x2);
            particles.set(i, P_Y, y2);
            particles.set(i, P_VX, vx);
            particles.set(i, P_VY, vy);
            particles.set(i, P_LIFE, life);
            const out = x > env.width || x < 0 || y > env.height || y < 0;
            if (out || life > ttl) initParticle(i);
        }

        particles.each(initParticle);

        return createFrameLoop(() => {
            tick++;
            beginFrame(env, opts);
            particles.each(updateParticle);
            compositeGlow(env, GLOW_PASSES);
        });
    }
}
