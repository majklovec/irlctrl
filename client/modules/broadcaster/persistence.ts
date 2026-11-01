import {
	SRTLA_CUSTOM_SERVICE,
	srtlaService,
	srtlaServiceForUrl,
} from "./services";

export interface OutputMetadata {
	service: string;
	url: string;
	keyConfigured: boolean;
}

export interface OutputSecret {
	service: string;
	url: string;
	key: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function urlForService(service: string, url: string): string {
	return url || srtlaService(service)?.servers[0]?.url || "";
}

function normalizedService(service: string, url: string): string {
	return service !== "" &&
		service !== SRTLA_CUSTOM_SERVICE &&
		srtlaService(service) !== undefined
		? service
		: srtlaServiceForUrl(url);
}

/**
 * Validate destinations submitted by the settings UI. An omitted key is
 * write-only: retain the existing key at that row's index.
 */
export function configuredOutputs(
	value: unknown,
	previousKeys: readonly string[],
): OutputSecret[] {
	if (!Array.isArray(value)) throw new Error("outputs must be an array");
	const outputs: OutputSecret[] = [];
	for (const [index, raw] of value.entries()) {
		if (!isRecord(raw)) continue;
		const service =
			typeof raw.service === "string" ? raw.service.trim() : "";
		const submittedUrl =
			typeof raw.url === "string" ? raw.url.trim() : "";
		const url = urlForService(service, submittedUrl);
		const submittedKey = typeof raw.key === "string" ? raw.key.trim() : "";
		if (url === "") continue;
		if (
			service !== "" &&
			service !== SRTLA_CUSTOM_SERVICE &&
			srtlaService(service) === undefined
		)
			throw new Error(`Unknown service: ${service}`);
		if (!isRtmpUrl(url))
			throw new Error(`RTMP URL must be an rtmp(s):// URL: ${url}`);
		outputs.push({
			service: normalizedService(service, url),
			url,
			key: submittedKey || previousKeys[index] || "",
		});
	}
	return outputs;
}

export function isRtmpUrl(url: string): boolean {
	try {
		const protocol = new URL(url).protocol;
		return protocol === "rtmp:" || protocol === "rtmps:";
	} catch {
		return false;
	}
}

export function outputMetadata(
	outputs: readonly OutputSecret[],
): OutputMetadata[] {
	return outputs.map(({ service, url, key }) => ({
		service,
		url,
		keyConfigured: key !== "",
	}));
}

/** Resolve the URL ffmpeg receives without ever exposing the key in metadata. */
export function effectiveOutputUrl(
	url: string,
	key: string,
	mask = false,
): string {
	if (url === "" || key === "") return url;
	const secret = mask ? "***" : key;
	try {
		const target = new URL(url);
		target.pathname = `${target.pathname.replace(/\/+$/, "")}/${secret}`;
		return target.toString();
	} catch {
		return `${url.replace(/\/+$/, "")}/${secret}`;
	}
}
