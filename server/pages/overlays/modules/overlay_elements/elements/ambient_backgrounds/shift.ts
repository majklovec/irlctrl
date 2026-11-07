/*
 * `shift` — large soft circles drifting, their hue cycling over time.
 * Port of `shift.js` from crnacura/AmbientCanvasBackgrounds (CC BY-SA).
 */

import { numProp, type OverlayElement } from "@ui/overlay/element";
import type { FormField } from "@ui/overlay/fields";
import type { PropReaders } from "../../../../../../core/overlay_element";
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
    rand,
    type SimplexNoise3D,
    TAU,
} from "./utils";

const CUSTOM_PROPS = [
    {
        key: "circle_count", labelKey: "overlay.ambient_circle_count",
        defaultValue: 150, min: 1, max: 1000, step: 1,
    },
    {
        key: "base_hue", labelKey: "overlay.ambient_base_hue",
        defaultValue: 220, min: 0, max: 360, step: 1,
    },
    {
        key: "range_hue", labelKey: "overlay.ambient_range_hue",
        defaultValue: 60, min: 0, max: 360, step: 1,
    },
    {
        key: "base_radius", labelKey: "overlay.ambient_base_radius",
        defaultValue: 100, min: 1, max: 1000, step: 1,
    },
    {
        key: "range_radius", labelKey: "overlay.ambient_range_radius",
        defaultValue: 200, min: 0, max: 2000, step: 1,
    },
] as const;

const BASE_SPEED = 0.1;
const RANGE_SPEED = 1;
const BASE_TTL = 150;
const RANGE_TTL = 200;
const X_OFF = 0.0015;
const Y_OFF = 0.0015;
const Z_OFF = 0.0015;

/** The single soft composite: one heavy blur, no additive blend. */
const GLOW_PASSES: readonly GlowPass[] = [{ filter: "blur(50px)" }];

/** Particle field ordinals: x, y, vx, vy, life, ttl, radius, hue. */
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_LIFE = 4;
const P_TTL = 5;
const P_RADIUS = 6;
const P_HUE = 7;

export class Shift extends AmbientVariant {
    readonly id = "shift";
    readonly labelKey = "overlay.ambient_shift";
    override readonly customDefaults: Record<string, number> = Object.fromEntries(
        CUSTOM_PROPS.map(({ key, defaultValue }) => [key, defaultValue]),
    );

    override normalizeCustomProps(
        _props: Readonly<Record<string, unknown>>,
        read: PropReaders,
    ): Record<string, number> {
        return Object.fromEntries(
            CUSTOM_PROPS.map(({ key, defaultValue, min, max }) => {
                const value = read.num(key, defaultValue, min, max);
                return [key, key === "circle_count" ? Math.round(value) : value];
            }),
        );
    }

    override customFormRows(element: OverlayElement): FormField[] {
        return CUSTOM_PROPS.map(
            ({ key, labelKey, defaultValue, min, max, step }) => ({
                path: `props.${key}`,
                labelKey,
                type: "number",
                value: numProp(element.props, key, defaultValue),
                min,
                max,
                step,
            }),
        );
    }

    start(env: AmbientEnv, opts: AmbientOptions): () => void {
        const {
            circle_count, base_hue, range_hue,
            base_radius, range_radius,
        } = opts.custom;
        const simplex: SimplexNoise3D = createSimplexNoise();
        const circles = new ParticlePool(Math.round(circle_count), 8);
        let baseHue = base_hue;

        function initCircle(i: number): void {
            const x = rand(env.width);
            const y = rand(env.height);
            const n = simplex.noise3D(x * X_OFF, y * Y_OFF, baseHue * Z_OFF);
            const t = rand(TAU);
            const speed = (BASE_SPEED + rand(RANGE_SPEED)) * opts.speed;
            const vx = speed * Math.cos(t);
            const vy = speed * Math.sin(t);
            const ttl = BASE_TTL + rand(RANGE_TTL);
            const radius = base_radius + rand(range_radius);
            const hue = baseHue + n * range_hue;
            circles.store(i, [x, y, vx, vy, 0, ttl, radius, hue]);
        }

        function drawCircle(i: number): void {
            const x = circles.at(i, P_X);
            const y = circles.at(i, P_Y);
            const life = circles.at(i, P_LIFE);
            const ttl = circles.at(i, P_TTL);
            const radius = circles.at(i, P_RADIUS);
            const hue = circles.at(i, P_HUE);
            env.aw.fillStyle = hsla(hue, 60, 30, fadeInOut(life, ttl));
            env.aw.beginPath();
            env.aw.arc(x, y, radius, 0, TAU);
            env.aw.fill();
            env.aw.closePath();
        }

        function updateCircle(i: number): void {
            drawCircle(i);
            const x = circles.at(i, P_X) + circles.at(i, P_VX);
            const y = circles.at(i, P_Y) + circles.at(i, P_VY);
            const life = circles.at(i, P_LIFE) + 1;
            const ttl = circles.at(i, P_TTL);
            const radius = circles.at(i, P_RADIUS);
            circles.set(i, P_X, x);
            circles.set(i, P_Y, y);
            circles.set(i, P_LIFE, life);
            const out =
                x < -radius ||
                x > env.width + radius ||
                y < -radius ||
                y > env.height + radius;
            if (out || life > ttl) initCircle(i);
        }

        circles.each(initCircle);

        return createFrameLoop(() => {
            beginFrame(env, opts);
            baseHue++;
            circles.each(updateCircle);
            compositeGlow(env, GLOW_PASSES);
        });
    }
}
