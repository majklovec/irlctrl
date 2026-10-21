/**
 * YouTube channel current-livestream viewer counts via the InnerTube API.
 * No API key, no external libraries. Pure ESM, uses only global fetch.
 *
 * Works in Node 18+ and in the DevTools console of any youtube.com tab
 * (same-origin there; cross-origin browser fetch is blocked by CORS).
 *
 *   import { getLiveViewers } from "./yt-live-viewers.mjs";
 *   console.log(await getLiveViewers("@AlJazeeraEnglish"));
 *   // { isLive: true, videoId, title, viewers: 28973, viewersText: "28,973 watching" }
 *   // { isLive: false }  when the channel is not streaming right now
 */

// Public values used by every youtube.com visitor; refreshed from the page when we can.
const DEFAULT_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // WEB client key
const DEFAULT_CLIENT_VERSION = "2.20261020.05.00"; // WEB client version
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Protobuf for the channel's "Live" tab.
const LIVE_TAB_PARAMS = "EgZ6AwgB";

let config = null; // { apiKey, clientVersion }

async function getConfig() {
    if (config) return config;
    try {
        const html = await getText("https://www.youtube.com/");
        const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
        const clientVersion = html.match(
            /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/,
        )?.[1];
        if (apiKey && clientVersion) config = { apiKey, clientVersion };
    } catch {
        /* fall through to defaults */
    }
    config ??= {
        apiKey: DEFAULT_API_KEY,
        clientVersion: DEFAULT_CLIENT_VERSION,
    };
    return config;
}

async function getText(url) {
    const res = await fetch(url, {
        headers: {
            accept: "text/html",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": UA,
        },
    });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    return res.text();
}

async function innertube(endpoint, payload) {
    const { apiKey, clientVersion } = await getConfig();
    const res = await fetch(
        `https://www.youtube.com/youtubei/v1/${endpoint}?key=${apiKey}&prettyPrint=false`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: "https://www.youtube.com",
                "user-agent": UA,
            },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: "WEB",
                        clientVersion,
                        hl: "en",
                        gl: "US",
                    },
                },
                ...payload,
            }),
        },
    );
    if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
    return res.json();
}

/** Accepts "UCxxxx...", "@handle", or a youtube.com channel URL of either form. */
function normalizeChannelInput(channel) {
    let token = String(channel).trim();
    const url = token.match(
        /youtube\.com\/((?:@[\w.-]+|channel\/UC[\w-]{22}|[\w.-]+))/,
    );
    if (url) token = url[1];
    token = token.replace(/^channel\//, "").replace(/^\/+/, "");
    if (/^UC[\w-]{22}$/.test(token)) return { kind: "id", value: token };
    if (/^@[\w.-]+$/.test(token)) return { kind: "handle", value: token };
    if (/^[\w.-]+$/.test(token)) return { kind: "handle", value: `@${token}` };
    throw new Error(`Cannot parse channel reference: ${channel}`);
}

async function resolveChannelId(channel) {
    const ref = normalizeChannelInput(channel);
    if (ref.kind === "id") return ref.value;
    // The base channel page carries the reliable identity fields; /live is a fallback.
    for (const suffix of ["", "/live"]) {
        try {
            const html = await getText(
                `https://www.youtube.com/${ref.value}${suffix}`,
            );
            const id =
                html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ??
                html.match(
                    /"channelMetadataRenderer":\{[^}]*"externalId":"(UC[\w-]{22})"/,
                )?.[1] ??
                html.match(
                    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
                )?.[1] ??
                html.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
            if (id) return id;
        } catch {
            /* try next suffix */
        }
    }
    throw new Error(`Could not resolve channel id for ${channel}`);
}

/** Depth-first search for the first object having `key` (or array of them). */
function findFirst(node, key) {
    if (Array.isArray(node)) {
        for (const item of node) {
            const hit = findFirst(item, key);
            if (hit) return hit;
        }
        return null;
    }
    if (node && typeof node === "object") {
        if (key in node) return node[key];
        for (const value of Object.values(node)) {
            const hit = findFirst(value, key);
            if (hit) return hit;
        }
    }
    return null;
}

const textOf = (runsOrText) =>
    runsOrText?.simpleText ??
    (Array.isArray(runsOrText?.runs)
        ? runsOrText.runs.map((r) => r.text).join("")
        : undefined);

const parseCount = (text) => {
    const match = text?.match(/[\d][\d.,\u00a0\u202F ]*/);
    return match
        ? Number(match[0].replace(/[.,\u00a0\u202F ]/g, ""))
        : undefined;
};

const WATCHING_RE = /\bwatching\b|наблюда|vervolgen| Watching/i;

/** Turn a viewCount-like renderer into { text, viewers } if it says "watching". */
function watchingCount(node) {
    const text = textOf(node);
    if (text && WATCHING_RE.test(text))
        return { text, viewers: parseCount(text) };
    return null;
}

/**
 * Returns { isLive, videoId?, title?, viewers?, viewersText?, channelId }
 * viewers = current concurrent viewers of the channel's live stream.
 */
export async function getLiveViewers(channel) {
    const channelId = await resolveChannelId(channel);

    const browse = await innertube("browse", {
        browseId: channelId,
        params: LIVE_TAB_PARAMS,
    });

    // Fast path: the Live tab itself already renders "N watching".
    const watchingHit = searchWatching(browse);
    const featured = findFirst(browse, "channelVideoPlayerRenderer");
    const videoId =
        featured?.videoId ??
        findFirst(browse, "lockupViewModel")?.contentId ??
        findFirst(browse, "watchEndpoint")?.videoId;

    if (watchingHit) {
        return {
            isLive: true,
            channelId,
            videoId,
            title: textOf(featured?.title) ?? undefined,
            viewers: watchingHit.viewers,
            viewersText: watchingHit.text,
        };
    }

    // Otherwise take the featured video on the Live tab (most recent broadcast)
    // and verify its real state on the watch-page endpoint.
    if (!videoId) return { isLive: false, channelId };

    const next = await innertube("next", { videoId });
    const primary = findFirst(next, "videoPrimaryInfoRenderer");
    const viewText = textOf(
        primary?.viewCount?.videoViewCountRenderer?.viewCount,
    );
    const title = textOf(primary?.title);
    const liveBadge = (primary?.title?.badges ?? []).some((b) =>
        /LIVE/i.test(textOf(b?.metadataBadgeRenderer) ?? JSON.stringify(b)),
    );

    const watching =
        viewText && WATCHING_RE.test(viewText)
            ? { text: viewText, viewers: parseCount(viewText) }
            : null;

    if (watching || liveBadge) {
        return {
            isLive: true,
            channelId,
            videoId,
            title,
            viewers: watching?.viewers,
            viewersText: watching?.text,
        };
    }
    return { isLive: false, channelId, videoId, title, viewsText: viewText };
}

function searchWatching(node) {
    if (Array.isArray(node)) {
        for (const item of node) {
            const hit = searchWatching(item);
            if (hit) return hit;
        }
        return null;
    }
    if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "viewCountText" || key === "viewCount") {
                const hit = watchingCount(value);
                if (hit) return hit;
            }
            const hit = searchWatching(value);
            if (hit) return hit;
        }
    }
    return null;
}

/** Watch a channel and invoke cb(result) on every poll; returns a stop function. */
export function watchLiveViewers(channel, cb, intervalMs = 30_000) {
    let stopped = false;
    const tick = async () => {
        if (stopped) return;
        try {
            cb(null, await getLiveViewers(channel));
        } catch (err) {
            cb(err);
        } finally {
            setTimeout(tick, intervalMs).unref?.();
        }
    };
    tick();
    return () => {
        stopped = true;
    };
}

// CLI: node yt-live-viewers.mjs @handle [UCid ...]
if (process.argv[1]) {
    const { pathToFileURL } = await import("node:url");
    if (import.meta.url === pathToFileURL(process.argv[1]).href) {
        for (const arg of process.argv.slice(2)) {
            console.log(arg, "->", await getLiveViewers(arg));
        }
    }
}
