/**
 * stats widget — local wire/state types. The module is self-contained:
 * it declares the shapes it exchanges over the dashboard websocket and the
 * hub/manager contract it implements.
 */

import type { StatsPlatform } from "./config";

/** One viewer-count sample for the line chart (oldest first). */
export interface StatsSample {
	t: number;
	v: number;
}

/** Latest stats sample for one platform channel. */
export interface StatsLive {
	platform: StatsPlatform;
	channel: string;
	viewers: number;
	isLive: boolean;
	title?: string;
	category?: string;
	followers?: number;
	startTime?: number;
	at: number;
	series: StatsSample[];
}

/** One channel's live state fragment on the wire. */
export interface ChannelLive {
	stats?: StatsLive | null;
}

/** Channels to keep attached (spec keys `<platform>:<channel>`). */
export type ChannelSpecs = Set<string>;

/** Deliver a serialized event frame to subscribers. */
export type PublishFn = (msg: string) => void;

/** Serialize an event frame for the module websockets. */
export const eventFrame = (event: string, data: unknown): string =>
	JSON.stringify({ type: "event", event, data });

/** A config parameter: free text or a fixed-choice dropdown. */
export type WidgetConfigField =
	| string
	| { name: string; type: "select"; options: readonly string[] }
	| { name: string; type: "hidden" };
