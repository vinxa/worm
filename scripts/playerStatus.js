const STATUS_EVENT_TYPES = new Set([
    "deactivated",
    "reactivated",
    "reload",
    "tagged",
]);

// A reload may be recorded immediately before the system-generated
// deactivation that starts the reload cycle. Treat that pair as one status
// transition; a later deactivation still interrupts the reload normally.
const RELOAD_DEACTIVATION_PAIR_SECONDS = 0.05;

function getStatusAfterEvent(status, eventType, timeSinceReload) {
    if (
        eventType === "deactivated" &&
        status === "reloading" &&
        timeSinceReload >= 0 &&
        timeSinceReload <= RELOAD_DEACTIVATION_PAIR_SECONDS
    ) return status;
    if (eventType === "deactivated" && status !== "dead") return "dead";
    if (eventType === "tagged" && status === "reloading") return "dead";
    if (eventType === "reload" && status !== "reloading") return "reloading";
    if (eventType === "reactivated" && status !== "alive") return "alive";
    return status;
}

export function buildPlayerStatusPeriods(events, gameEnd) {
    const end = Number(gameEnd);
    if (!Number.isFinite(end) || end <= 0) return [];

    const statusEvents = (Array.isArray(events) ? events : [])
        .map((event, index) => ({
            event,
            index,
            time: Math.max(0, Math.min(end, Number(event?.time))),
        }))
        .filter(({ event, time }) =>
            STATUS_EVENT_TYPES.has(event?.type) && Number.isFinite(time)
        )
        .sort((a, b) => a.time - b.time || a.index - b.index);

    const periods = [];
    let status = "alive";
    let lastTime = 0;
    let lastReloadTime = -Infinity;

    statusEvents.forEach(({ event, time }) => {
        if (event.type === "reload") lastReloadTime = time;
        const nextStatus = getStatusAfterEvent(status, event.type, time - lastReloadTime);
        if (nextStatus === status) return;
        if (time > lastTime) periods.push({ from: lastTime, to: time, status });
        status = nextStatus;
        lastTime = time;
    });

    if (end > lastTime) periods.push({ from: lastTime, to: end, status });
    return periods;
}
