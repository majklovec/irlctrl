/* Minimal CLI argument helpers shared by the relay and the control server. */
export const argv = Bun.argv.slice(2);
export const flag = (name: string): boolean => argv.includes(name);

export const argFail = (
    name: string,
    value: string,
    expected: string,
): never => {
    console.error(
        `Invalid value for ${name}: "${value}" (expected ${expected})`,
    );
    process.exit(2);
};

/** Reads `--name value` or `--name=value`; the overload guarantees a string when a fallback is given. */
export function arg(name: string): string | undefined;
export function arg(name: string, fallback: string): string;
export function arg(name: string, fallback?: string): string | undefined {
    const prefix = `${name}=`;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === name) return argv[i + 1] ?? fallback;
        if (a.startsWith(prefix)) return a.slice(prefix.length);
    }
    return fallback;
}

export const intArg = (
    name: string,
    fallback: number,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
): number => {
    const raw = arg(name);
    if (raw === undefined) return fallback;
    return parseBoundedInt(name, raw, fallback, min, max);
};

export const enumArg = <T extends string>(
    name: string,
    allowed: readonly T[],
    fallback: T,
): T => {
    const raw = arg(name);
    if (raw === undefined) return fallback;
    return (allowed as readonly string[]).includes(raw)
        ? (raw as T)
        : argFail(name, raw, allowed.join(" | "));
};

function parseBoundedInt(
    name: string,
    raw: string,
    fallback: number,
    min: number,
    max: number,
): number {
    if (raw === "") return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max
        ? n
        : argFail(name, raw, `integer ${min}-${max}`);
}

// ── Unified CLI + env resolution ───────────────────────────────────────────
// Every role resolves a setting the same way: CLI flag > env var > fallback
// (the fallback is the config-file value or the default). Use the *Env
// helpers below instead of inlining `process.env` lookups.

/** True when the env var is set to a truthy value (1/true/yes/on, case-insensitive). */
export const envFlag = (name: string): boolean => {
    const v = process.env[name]?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
};

/** Boolean setting: a CLI flag or its env var (truthy values above). */
export const flagOrEnv = (name: string, envName: string): boolean =>
    flag(name) || envFlag(envName);

/** String setting: CLI flag > env var > fallback. */
export function argEnv(name: string, envName: string): string | undefined;
export function argEnv(name: string, envName: string, fallback: string): string;
export function argEnv(
    name: string,
    envName: string,
    fallback?: string,
): string | undefined {
    return arg(name) ?? process.env[envName] ?? fallback;
}

/** Integer setting: CLI flag > env var > fallback. */
export const intArgEnv = (
    name: string,
    envName: string,
    fallback: number,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
): number => {
    const raw = arg(name) ?? process.env[envName];
    if (raw === undefined) return fallback;
    return parseBoundedInt(name, raw, fallback, min, max);
};

/** Enum setting: CLI flag > env var > fallback. */
export const enumArgEnv = <T extends string>(
    name: string,
    allowed: readonly T[],
    envName: string,
    fallback: T,
): T => enumArg(name, allowed, process.env[envName] ?? fallback);
