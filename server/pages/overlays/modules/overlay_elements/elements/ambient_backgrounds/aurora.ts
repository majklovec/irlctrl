/*
 * `aurora` — rays rising from the middle band through a noise field.
 * Port of `aurora.js` from crnacura/AmbientCanvasBackgrounds (CC BY-SA).
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
    rand,
    type SimplexNoise3D,
} from "./utils";

const RAY_COUNT = 500;
const BASE_LENGTH = 200;
const RANGE_LENGTH = 200;
const BASE_SPEED = 0.05;
const RANGE_SPEED = 0.1;
const BASE_WIDTH = 10;
const RANGE_WIDTH = 20;
const BASE_HUE = 120;
const RANGE_HUE = 60;
const BASE_TTL = 50;
const RANGE_TTL = 100;
const NOISE_STRENGTH = 100;
const X_OFF = 0.0015;
const Y_OFF = 0.0015;
const Z_OFF = 0.0015;

/** Single soft composite: one blur, no additive blend. */
const GLOW_PASSES: readonly GlowPass[] = [{ filter: "blur(12px)" }];

/** Ray field ordinals: coord, e1, e2, life, ttl, width, speed, hue. */
const P_COORD = 0;
const P_E1 = 1;
const P_E2 = 2;
const P_LIFE = 3;
const P_TTL = 4;
const P_WIDTH = 5;
const P_SPEED = 6;
const P_HUE = 7;

export class Aurora extends AmbientVariant {
    readonly id = "aurora";
    readonly labelKey = "overlay.ambient_aurora";

    start(env: AmbientEnv, opts: AmbientOptions): () => void {
        // Rays rise from a middle band that runs along the box's longer axis:
        // a horizontal band (vertical rays) when the box is wider than tall,
        // a vertical band (horizontal rays) otherwise. `coord` is the position
        // along that band, `e1`/`e2` the ray's endpoints across it.
        const horizontalBand = env.width >= env.height;
        const bandLength = horizontalBand ? env.width : env.height;
        const bandMid =
            0.5 * (horizontalBand ? env.height : env.width) + NOISE_STRENGTH;
        let tick = 0;
        const simplex: SimplexNoise3D = createSimplexNoise();
        const rays = new ParticlePool(RAY_COUNT, 8);

        function initRay(i: number): void {
            const length = BASE_LENGTH + rand(RANGE_LENGTH);
            const coord = rand(bandLength);
            let e1 = bandMid;
            let e2 = bandMid - length;
            const n =
                simplex.noise3D(coord * X_OFF, e1 * Y_OFF, tick * Z_OFF) *
                NOISE_STRENGTH;
            e1 += n;
            e2 += n;
            const ttl = BASE_TTL + rand(RANGE_TTL);
            const width = BASE_WIDTH + rand(RANGE_WIDTH);
            const sign = Math.round(rand(1)) ? 1 : -1;
            const speed = (BASE_SPEED + rand(RANGE_SPEED) * sign) * opts.speed;
            const hue = BASE_HUE + rand(RANGE_HUE);
            rays.store(i, [coord, e1, e2, 0, ttl, width, speed, hue]);
        }

        function drawRay(i: number): void {
            const coord = rays.at(i, P_COORD);
            const e1 = rays.at(i, P_E1);
            const e2 = rays.at(i, P_E2);
            const life = rays.at(i, P_LIFE);
            const ttl = rays.at(i, P_TTL);
            const width = rays.at(i, P_WIDTH);
            const hue = rays.at(i, P_HUE);
            const g = horizontalBand
                ? env.aw.createLinearGradient(coord, e1, coord, e2)
                : env.aw.createLinearGradient(e1, coord, e2, coord);
            g.addColorStop(0, `hsla(${hue},100%,65%,0)`);
            g.addColorStop(
                0.5,
                `hsla(${hue},100%,65%,${fadeInOut(life, ttl)})`,
            );
            g.addColorStop(1, `hsla(${hue},100%,65%,0)`);
            env.aw.beginPath();
            env.aw.strokeStyle = g;
            env.aw.lineWidth = width;
            env.aw.moveTo(
                horizontalBand ? coord : e1,
                horizontalBand ? e1 : coord,
            );
            env.aw.lineTo(
                horizontalBand ? coord : e2,
                horizontalBand ? e2 : coord,
            );
            env.aw.stroke();
            env.aw.closePath();
        }

        function updateRay(i: number): void {
            const coord = rays.at(i, P_COORD);
            const life = rays.at(i, P_LIFE);
            const ttl = rays.at(i, P_TTL);
            const speed = rays.at(i, P_SPEED);

            drawRay(i);
            const ncoord = coord + speed;
            rays.set(i, P_COORD, ncoord);
            const nlife = life + 1;
            rays.set(i, P_LIFE, nlife);
            if (ncoord < 0 || ncoord > bandLength || nlife > ttl) initRay(i);
        }

        rays.each(initRay);

        return createFrameLoop(() => {
            tick++;
            beginFrame(env, opts);
            rays.each(updateRay);
            compositeGlow(env, GLOW_PASSES);
        });
    }
}
