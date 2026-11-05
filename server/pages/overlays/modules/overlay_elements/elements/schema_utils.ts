/*
 * Shared environment-free normalizers for the schema halves of the built-in
 * overlay elements (`elements/*.schema.ts`). The list props are normalized
 * here (the scalar `read` helpers can't touch object arrays), mirroring how
 * the alert and chat schemas handle their structured props. Kept free of the
 * browser lib (which imports mithril) — the server's scene validator reaches
 * these files through generated/overlay_schemas.ts.
 */

/** Defensive scalar coercions for the list-row normalizers below. */
export const cleanStr = (v: unknown, max: number): string =>
    typeof v === "string" ? v.slice(0, max) : "";
export const cleanNum = (
    v: unknown,
    def: number,
    min = 0,
    max = 1e12,
): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
export const cleanBool = (v: unknown): boolean => v === true;

/** A platform channel a chat-driven widget displays (mirrors the chat
 * element's `channels`). Kept here so the schemas stay free of the browser
 * lib (which imports mithril). */
export interface ChannelRow {
    platform: "youtube" | "twitch" | "tiktok" | "kick";
    channel: string;
}
export const CHAT_PLATFORMS = [
    "youtube",
    "twitch",
    "tiktok",
    "kick",
] as const;
export function normalizeChannelRows(raw: unknown, max = 8): ChannelRow[] {
    if (!Array.isArray(raw)) return [];
    const out: ChannelRow[] = [];
    for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const platform = (item as { platform?: unknown }).platform;
        if (
            typeof platform !== "string" ||
            !(CHAT_PLATFORMS as readonly string[]).includes(platform)
        )
            continue;
        const channel = cleanStr(
            (item as { channel?: unknown }).channel as string | undefined,
            100,
        )
            .trim()
            .toLowerCase();
        out.push({ platform: platform as ChannelRow["platform"], channel });
        if (out.length >= max) break;
    }
    return out;
}
/** A generic `{label, ...}` text row. */
export function textRows(
    raw: unknown,
    max: number,
    second?: { key: string; kind: "str" | "num" | "bool" },
): Array<Record<string, unknown>> {
    if (!Array.isArray(raw)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const label = cleanStr(rec.label, 120);
        const row: Record<string, unknown> = { label };
        if (second) {
            if (second.kind === "num")
                row[second.key] = cleanNum(rec[second.key], 0);
            else if (second.kind === "bool")
                row[second.key] = cleanBool(rec[second.key]);
            else row[second.key] = cleanStr(rec[second.key], 120);
        }
        out.push(row);
        if (out.length >= max) break;
    }
    return out;
}
