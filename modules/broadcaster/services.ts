/**
 * Streaming-service catalog for the relay's RTMP destinations, derived from
 * the OBS rtmp-services definitions (`services.json`, format v5) that ship
 * with this module. Entries keep only the RTMP/RTMPS inpoints (OBS also
 * lists some services' HTTPS inpoints, which this relay cannot use); one
 * entry per service, inpoints in the OBS order. A catalog entry with no
 * servers at all (the "Custom" placeholder) is kept as-is: its URL is
 * typed in by the operator and it carries no inpoints.
 *
 * Own of the broadcaster module — imported by the device agent
 * (validation, config defaults) and the web settings UI (the per-destination
 * service/server selects), so both sides agree on the same ids. The JSON is
 * inlined at build time; nothing reads it from disk at runtime.
 */
import raw from "./services.json";

/** A single inpoint (server): its OBS display name and RTMP/RTMPS URL. */
export interface SrtlaServer {
	name: string;
	url: string;
}

/** One RTMP destination service. */
export interface SrtlaService {
	/** Stable id used in the config file and the service select. */
	id: string;
	/** Display name (from the OBS catalog). */
	name: string;
	/** RTMP/RTMPS inpoints, OBS order; the first is the default server. */
	servers: SrtlaServer[];
	/** Commonly used platform; the service select lists these first. */
	common: boolean;
}

/** The OBS catalog shape (format v5) as far as this module uses it. */
interface ObsService {
	name: string;
	common?: boolean;
	servers: { name: string; url: string }[];
}

const OBS_CATALOG = (raw as { services: ObsService[] }).services;

/** "YouTube - RTMPS" → "youtube-rtmps" (stable, collision-free). */
function slug(name: string): string {
	const chars: string[] = [];
	for (const ch of name.toLowerCase()) {
		const alnum = (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "z");
		if (alnum) chars.push(ch);
		else if (chars.length > 0 && chars[chars.length - 1] !== "-")
			chars.push("-");
	}
	return chars.join("").replace(/^-+|-+$/g, "");
}

function rtmpInpoints(svc: ObsService): SrtlaServer[] {
	const seen = new Set<string>();
	const urls: SrtlaServer[] = [];
	for (const server of svc.servers) {
		if (!server.url.startsWith("rtmp://") && !server.url.startsWith("rtmps://"))
			continue;
		if (seen.has(server.url)) continue;
		seen.add(server.url);
		urls.push({ name: server.name, url: server.url });
	}
	return urls;
}

/**
 * The catalog: catalog order, RTMP inpoints only. Entries with no servers
 * at all (the "Custom" placeholder) are kept; entries that only offer
 * non-RTMP inpoints are dropped.
 */
export const SRTLA_SERVICES: SrtlaService[] = OBS_CATALOG.flatMap((svc) => {
	const servers = rtmpInpoints(svc);
	return servers.length > 0 || svc.servers.length === 0
		? [
				{
					id: slug(svc.name),
					name: svc.name,
					servers,
					common: svc.common === true,
				},
			]
		: [];
});

export const SRTLA_CUSTOM_SERVICE = "custom";

export function srtlaService(id: string): SrtlaService | undefined {
	return SRTLA_SERVICES.find((s) => s.id === id);
}

/** Host + path of a URL for comparison (query, trailing slash dropped). */
function hostPath(url: string): { host: string; path: string } | null {
	try {
		const u = new URL(url);
		return { host: u.hostname, path: u.pathname.replace(/\/$/, "") };
	} catch {
		return null;
	}
}

/**
 * Match a URL against the catalog (any inpoint, host + path, so the
 * per-service backup inpoints don't collapse onto different services) to
 * infer its service. Returns "custom" for URLs no entry matches.
 */
export function srtlaServiceForUrl(url: string): string {
	const target = hostPath(url);
	if (target === null) return SRTLA_CUSTOM_SERVICE;
	for (const svc of SRTLA_SERVICES) {
		for (const server of svc.servers) {
			const s = hostPath(server.url);
			if (s !== null && s.host === target.host && s.path === target.path)
				return svc.id;
		}
	}
	return SRTLA_CUSTOM_SERVICE;
}
