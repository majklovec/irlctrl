import type { PlatformStats } from "./types";

const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_YOUTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const DEFAULT_YOUTUBE_CLIENT_VERSION = "2.20261020.05.00";
const YOUTUBE_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const LIVE_TAB_PARAMS = "EgZ6AwgB";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function findFirst(node: unknown, key: string): unknown {
	if (Array.isArray(node)) {
		for (const item of node) {
			const hit = findFirst(item, key);
			if (hit !== null && hit !== undefined) return hit;
		}
		return null;
	}
	const object = asObject(node);
	if (!object) return null;
	if (key in object) return object[key];
	for (const value of Object.values(object)) {
		const hit = findFirst(value, key);
		if (hit !== null && hit !== undefined) return hit;
	}
	return null;
}

function textOf(value: unknown): string | undefined {
	const object = asObject(value);
	if (!object) return typeof value === "string" ? value : undefined;
	if (typeof object.simpleText === "string") return object.simpleText;
	if (!Array.isArray(object.runs)) return undefined;
	return object.runs
		.map((run) => asObject(run)?.text)
		.filter((text): text is string => typeof text === "string")
		.join("");
}

function parseCount(text: string | undefined): number | undefined {
	const match = text?.match(/[\d][\d.,\u00a0\u202f ]*/);
	if (!match) return undefined;
	const count = Number(match[0].replace(/[.,\u00a0\u202f ]/g, ""));
	return Number.isFinite(count) ? count : undefined;
}

const WATCHING_RE = /\bwatching\b|наблюда|vervolgen| Watching/i;

function searchWatching(node: unknown): number | undefined {
	if (Array.isArray(node)) {
		for (const item of node) {
			const hit = searchWatching(item);
			if (hit !== undefined) return hit;
		}
		return undefined;
	}
	const object = asObject(node);
	if (!object) return undefined;
	for (const [key, value] of Object.entries(object)) {
		if (key === "viewCountText" || key === "viewCount") {
			const text = textOf(value);
			if (text && WATCHING_RE.test(text)) return parseCount(text) ?? 0;
		}
		const hit = searchWatching(value);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

function youtubeInput(channel: string): {
	kind: "id" | "handle";
	value: string;
} {
	let token = channel.trim();
	const url = token.match(
		/youtube\.com\/((?:@[\w.-]+|channel\/UC[\w-]{22}|[\w.-]+))/i,
	);
	if (url) token = url[1]!;
	token = token.replace(/^channel\//i, "").replace(/^\/+/, "");
	if (/^UC[\w-]{22}$/i.test(token)) return { kind: "id", value: token };
	if (/^@[\w.-]+$/.test(token))
		return { kind: "handle", value: token.toLowerCase() };
	if (/^[\w.-]+$/.test(token))
		return { kind: "handle", value: `@${token.toLowerCase()}` };
	throw new Error(`Cannot parse YouTube channel reference: ${channel}`);
}

async function youtubeText(url: string): Promise<string> {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: {
			accept: "text/html",
			"accept-language": "en-US,en;q=0.9",
			"user-agent": YOUTUBE_UA,
		},
	});
	if (!res.ok) throw new Error(`YouTube GET failed: HTTP ${res.status}`);
	return res.text();
}

const youtubeChannelIds = new Map<string, Promise<string>>();

async function resolveYoutubeChannelId(channel: string): Promise<string> {
	const ref = youtubeInput(channel);
	if (ref.kind === "id") return ref.value;
	let resolution = youtubeChannelIds.get(ref.value);
	if (!resolution) {
		resolution = (async () => {
			let lastError: unknown;
			for (const suffix of ["", "/live"]) {
				try {
					const html = await youtubeText(
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
				} catch (err: unknown) {
					lastError = err;
				}
			}
			const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
			throw new Error(
				`Could not resolve YouTube channel id for ${channel}${detail}`,
				{ cause: lastError },
			);
		})();
		youtubeChannelIds.set(ref.value, resolution);
	}
	try {
		return await resolution;
	} catch (err: unknown) {
		youtubeChannelIds.delete(ref.value);
		throw err;
	}
}

let youtubeConfig: Promise<{ apiKey: string; clientVersion: string }> | null =
	null;

function getYoutubeConfig(): Promise<{
	apiKey: string;
	clientVersion: string;
}> {
	youtubeConfig ??= (async () => {
		try {
			const html = await youtubeText("https://www.youtube.com/");
			const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
			const clientVersion = html.match(
				/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/,
			)?.[1];
			if (apiKey && clientVersion) return { apiKey, clientVersion };
			console.warn("[stats youtube] using fallback InnerTube client config");
		} catch (err: unknown) {
			console.warn(
				`[stats youtube] could not refresh InnerTube config: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return {
			apiKey: DEFAULT_YOUTUBE_API_KEY,
			clientVersion: DEFAULT_YOUTUBE_CLIENT_VERSION,
		};
	})();
	return youtubeConfig;
}

async function youtubeInnertube(
	endpoint: "browse" | "next",
	payload: JsonObject,
): Promise<unknown> {
	const { apiKey, clientVersion } = await getYoutubeConfig();
	const res = await fetch(
		`https://www.youtube.com/youtubei/v1/${endpoint}?key=${apiKey}&prettyPrint=false`,
		{
			method: "POST",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				"content-type": "application/json",
				origin: "https://www.youtube.com",
				"user-agent": YOUTUBE_UA,
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
	if (!res.ok) throw new Error(`YouTube ${endpoint} HTTP ${res.status}`);
	return res.json();
}

export async function fetchYoutubeStats(
	channel: string,
): Promise<PlatformStats> {
	const channelId = await resolveYoutubeChannelId(channel);
	const browse = await youtubeInnertube("browse", {
		browseId: channelId,
		params: LIVE_TAB_PARAMS,
	});
	const featured = asObject(findFirst(browse, "channelVideoPlayerRenderer"));
	const videoId =
		featured?.videoId ??
		asObject(findFirst(browse, "lockupViewModel"))?.contentId ??
		asObject(findFirst(browse, "watchEndpoint"))?.videoId;
	const watching = searchWatching(browse);
	if (watching !== undefined) {
		return {
			isLive: true,
			viewers: watching,
			title: textOf(featured?.title),
		};
	}
	if (typeof videoId !== "string") return { isLive: false, viewers: 0 };

	const next = await youtubeInnertube("next", { videoId });
	const primary = asObject(findFirst(next, "videoPrimaryInfoRenderer"));
	const viewCount = asObject(primary?.viewCount);
	const viewRenderer = asObject(viewCount?.videoViewCountRenderer);
	const viewText = textOf(viewRenderer?.viewCount);
	const title = textOf(primary?.title);
	const titleData = asObject(primary?.title);
	const badges = Array.isArray(titleData?.badges) ? titleData.badges : [];
	const liveBadge = badges.some((badge) =>
		/LIVE/i.test(
			textOf(asObject(badge)?.metadataBadgeRenderer) ?? JSON.stringify(badge),
		),
	);
	const liveViewers =
		viewText && WATCHING_RE.test(viewText) ? parseCount(viewText) : undefined;
	const isLive = liveViewers !== undefined || liveBadge;
	return {
		isLive,
		viewers: liveViewers ?? 0,
		title,
	};
}
