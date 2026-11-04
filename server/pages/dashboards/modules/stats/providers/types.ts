/** One platform's current stream state, before timestamp/history is added. */
export interface PlatformStats {
    viewers?: number;
    isLive: boolean;
    title?: string;
    category?: string;
    followers?: number;
    startTime?: number;
}
