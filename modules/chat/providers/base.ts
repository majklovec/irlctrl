/**
 * Shared per-channel state machine for the chat providers. Each platform
 * provider owns its transport (poll loop, IRC websocket, connector, Pusher)
 * and pushes messages through `deliver`; this base owns the parts all four
 * backends shared: the rolling newest-first history (so reconnections don't
 * re-send), the bounded `seen` id set (dedupe across reconnects), the
 * exponential reconnect backoff, and the connection-state frames
 * (`reconnect` with the rolling buffer, `disconnected`).
 */
import {
    CHAT_BANNED_TYPE,
    type ChatLive,
    type ChatPlatform,
    eventFrame,
    type PublishFn,
} from "../types";

/** Rolling history size per channel (newest first). */
export const HISTORY_CAP = 500;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

export abstract class ChatProvider {
    /** Normalized channel name (lowercased, no `@`). */
    readonly channel: string;
    /** The platform this provider serves; the wire event is `<platform>.chat`. */
    protected readonly platform: ChatPlatform;
    protected readonly publish: PublishFn;
    connected = false;
    protected stopped = false;
    protected attempt = 0;
    /** most recent messages, newest first */
    protected history: ChatLive[] = [];
    /** recent message ids, deduped across reconnects */
    protected seen = new Set<string>();
    protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(platform: ChatPlatform, channel: string, publish: PublishFn) {
        this.platform = platform;
        this.channel = channel;
        this.publish = publish;
    }

    /** The snapshot entry for this channel (`widget.snapshot` feed). */
    snapshot(): { connected: boolean; messages: ChatLive[] } {
        return { connected: this.connected, messages: [...this.history] };
    }

    /** Open the transport (the manager's first start of this channel). */
    start(): void {
        this.connect();
    }

    /** Open the transport (first connect and every backoff retry). */
    protected abstract connect(): void;
    /** Close the transport (stop / shutdown). */
    protected abstract teardown(): void;

    stop(): void {
        this.stopped = true;
        this.clearReconnect();
        this.teardown();
    }

    /** Push one message through dedupe/history and out to subscribers. */
    protected deliver(line: ChatLive): void {
        if (this.stopped) return;
        const key = String(line.id);
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.history.unshift(line);
        if (this.history.length > HISTORY_CAP)
            this.history.length = HISTORY_CAP;
        // Shed ids of messages evicted from the buffer (newest first, so the
        // tail is oldest) to keep `seen` bounded.
        while (this.seen.size > HISTORY_CAP * 2) {
            const oldest = this.history.pop();
            if (oldest) this.seen.delete(String(oldest.id));
        }
        const event = `${this.platformName()}.chat`;
        this.publish(
            eventFrame(event, { channel: this.channel, message: line }),
        );
    }

    /**
     * Mark one of this channel's messages as removed by moderation. Updates
     * the rolling history in place (so reconnection snapshots and the
     * `widget.snapshot` feed carry the flag) and broadcasts a `banned` frame
     * so live viewers strike/refresh the line and stop any in-flight TTS for
     * it. Ids not yet in history (already evicted) are carried to the frame
     * as-is — the frontend drops them harmlessly. Returns the ids it touched.
     */
    markBanned(ids: (string | number)[]): (string | number)[] {
        if (!ids.length) return [];
        const wanted = new Set(ids.map(String));
        const affected: (string | number)[] = [];
        for (const line of this.history) {
            if (wanted.has(String(line.id)) && line.type !== CHAT_BANNED_TYPE) {
                line.type = CHAT_BANNED_TYPE;
                affected.push(line.id);
            }
        }
        this.publish(
            eventFrame(`${this.platformName()}.chat`, {
                channel: this.channel,
                banned: { ids },
            }),
        );
        return affected;
    }

    /** The ids of this user's messages currently in the rolling history
     * (case-insensitive on the display name) — for a platform "user banned"
     * signal that arrives without per-message ids. */
    historyIdsForUser(username: string): (string | number)[] {
        const want = username.trim().toLowerCase();
        if (!want) return [];
        return this.history
            .filter((line) => (line.username ?? "").toLowerCase() === want)
            .map((line) => line.id);
    }

    /**
     * Mark every message of a banned user as removed by moderation. A
     * platform "user banned" signal (Twitch `CLEARCHIT`, Kick
     * `UserBannedEvent`) names only the person, not the messages, so this
     * resolves their messages in the rolling history and marks them banned.
     * Returns the ids it touched (empty when the name matches no one in
     * history — a channel-wide clear's free-text reason marks nothing).
     */
    banUser(username: string): (string | number)[] {
        const name = (username ?? "").trim();
        if (!name) return [];
        const ids = this.historyIdsForUser(name);
        return ids.length ? this.markBanned(ids) : [];
    }

    /**
     * Flip the connection state, emitting the matching frame: on connecting
     * the rolling buffer is re-delivered (a fresh viewer can top up), on
     * disconnecting subscribers learn the channel went dark.
     */
    protected setConnected(connected: boolean): void {
        const was = this.connected;
        this.connected = connected;
        const event = `${this.platformName()}.chat`;
        if (connected) {
            this.attempt = 0;
            if (!was)
                this.publish(
                    eventFrame(event, {
                        channel: this.channel,
                        reconnect: true,
                        messages: this.history,
                    }),
                );
            return;
        }
        if (was)
            this.publish(
                eventFrame(event, {
                    channel: this.channel,
                    disconnected: true,
                }),
            );
    }

    /** Platform name for the wire event / log prefix. */
    protected platformName(): string {
        return this.platform;
    }

    protected log(tag: string, message: string): void {
        console.warn(
            `[chat ${this.platformName()} ${this.channel}] ${tag}: ${message}`,
        );
    }

    protected clearReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /** Retry with exponential backoff (1 s base, 30 s cap), capped by `stopped`. */
    protected scheduleReconnect(): void {
        if (this.stopped) return;
        const delay = Math.min(
            RECONNECT_BASE_MS * 2 ** this.attempt,
            RECONNECT_MAX_MS,
        );
        this.attempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }
}
