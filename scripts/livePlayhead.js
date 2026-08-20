export const LIVE_EDGE_TOLERANCE_SECONDS = 0.1;

export function isAtLiveEdge(time, presentationTime) {
    return Number(time) >= Number(presentationTime) - LIVE_EDGE_TOLERANCE_SECONDS;
}

export function resolveLivePlayheadTime({
    currentTime,
    presentationTime,
    duration,
    following,
}) {
    const safeDuration = Math.max(0, Number(duration) || 0);
    const safeCurrentTime = Math.max(0, Number(currentTime) || 0);
    const safePresentationTime = Math.max(0, Number(presentationTime) || 0);
    const nextTime = following
        ? Math.max(safeCurrentTime, safePresentationTime)
        : safeCurrentTime;
    return Math.min(safeDuration, nextTime);
}
