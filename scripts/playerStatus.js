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
        const pairedReloadDeactivation = event.type === "deactivated" &&
            status === "reloading" &&
            time - lastReloadTime >= 0 &&
            time - lastReloadTime <= RELOAD_DEACTIVATION_PAIR_SECONDS;
        let nextStatus = status;
        if (event.type === "deactivated" && status !== "dead" && !pairedReloadDeactivation) {
            nextStatus = "dead";
        } else if (event.type === "tagged" && status === "reloading") {
            nextStatus = "dead";
        } else if (event.type === "reload" && status !== "reloading") {
            nextStatus = "reloading";
        } else if (event.type === "reactivated" && status !== "alive") {
            nextStatus = "alive";
        }
        if (nextStatus === status) return;
        if (time > lastTime) periods.push({ from: lastTime, to: time, status });
        status = nextStatus;
        lastTime = time;
    });

    if (end > lastTime) periods.push({ from: lastTime, to: end, status });
    return periods;
}
