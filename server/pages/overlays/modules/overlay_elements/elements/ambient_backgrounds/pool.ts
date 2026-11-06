/*
 * `ParticlePool` — the particle storage shared by the ambient backgrounds.
 *
 * A background is a fixed number of particles, each described by a fixed
 * number of numeric fields (x, y, vx, life, hue, …). The pool keeps them in
 * one tight, pre-allocated `Float32Array` (no per-frame allocations, no GC
 * churn) and hides the `count × stride` bookkeeping: callers index by
 * particle slot and a local field ordinal instead of managing the flat
 * offset, the `*_PROP_COUNT`/`*_PROPS_LENGTH` pair and the
 * `for (i = 0; i < LEN; i += COUNT)` loops by hand.
 *
 * Accessors are bounds- and type-unchecked on purpose — this is a hot path.
 */
export class ParticlePool {
    /** Number of particles (slots). */
    readonly count: number;
    /** Number of numeric fields per particle (the stride). */
    readonly stride: number;
    /** Backing storage: `count × stride` floats. Exposed for the rare loop
     * that wants the raw array (e.g. a bulk `set`); prefer the accessors. */
    readonly data: Float32Array;

    constructor(count: number, stride: number) {
        this.count = count;
        this.stride = stride;
        this.data = new Float32Array(count * stride);
    }

    /** Read field `f` of particle `i`. */
    at(i: number, f: number): number {
        return this.data[i * this.stride + f];
    }

    /** Write field `f` of particle `i`. */
    set(i: number, f: number, v: number): void {
        this.data[i * this.stride + f] = v;
    }

    /** Write whole particle `i` from `values` (written in field order 0..n).
     * Mirrors `Float32Array.set(values, i * stride)` — use it in an `init`
     * to seed a particle from a positional list. */
    store(i: number, values: readonly number[]): void {
        const base = i * this.stride;
        for (let k = 0; k < values.length; k++) this.data[base + k] = values[k];
    }

    /** Call `fn` once per particle index (0..count-1). Replaces the
     * `for (let i = 0; i < LEN; i += COUNT)` loops. */
    each(fn: (i: number) => void): void {
        for (let i = 0; i < this.count; i++) fn(i);
    }
}
