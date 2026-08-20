export function liveEventIdentity(event) {
    return JSON.stringify([
        event?.seqNo ?? null,
        event?.time ?? null,
        event?.entity ?? null,
        event?.target ?? null,
        event?.type ?? null,
        event?.delta ?? null,
    ]);
}

export function takeUnseenLiveEvents(events, seenKeys) {
    const unseen = [];
    (Array.isArray(events) ? events : []).forEach((event) => {
        if (!event) return;
        const key = liveEventIdentity(event);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        unseen.push(event);
    });
    return unseen;
}

export function compactLiveRenderData(data, events) {
    if (!data || typeof data !== "object") return data;
    return { ...data, events: Array.isArray(events) ? events : [] };
}

export function splitLiveRenderEvents(events, effectEvents, fallbackEventTime = 0) {
    const updates = (Array.isArray(events) ? events : []).map((event) => ({
        events: [event],
        effectEvents: (Array.isArray(effectEvents) ? effectEvents : []).includes(event)
            ? [event]
            : [],
        latestEventTime: Number(event?.time) || 0,
    }));
    return updates.length ? updates : [{
        events: [],
        effectEvents: [],
        latestEventTime: Number(fallbackEventTime) || 0,
    }];
}

export function mergeReadyLiveRenderData(current, latest, readyUpdates) {
    const sameGame = current?.gameKey && current.gameKey === latest?.gameKey;
    const base = sameGame ? current : {};
    const seenKeys = new Set();
    const events = takeUnseenLiveEvents(base.events, seenKeys);
    (readyUpdates || []).forEach((update) => {
        events.push(...takeUnseenLiveEvents(update?.data?.events, seenKeys));
    });
    return { ...base, ...latest, events };
}

export function insertPendingLiveRender(queue, update) {
    const comesBefore = (left, right) =>
        left.readyAt < right.readyAt ||
        (left.readyAt === right.readyAt && left.order < right.order);
    if (!queue.length || !comesBefore(update, queue[queue.length - 1])) {
        queue.push(update);
        return;
    }

    let low = 0;
    let high = queue.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (comesBefore(queue[middle], update)) low = middle + 1;
        else high = middle;
    }
    queue.splice(low, 0, update);
}
