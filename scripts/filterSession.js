import { state } from "./state.js";

const STORAGE_KEY = "worm-game-filters";

const FILTER_DEFAULTS = {
    gameFilter: "all",
    eventFilter: "none",
    gameDateFilter: "all",
    favouritesOnly: false,
    autoEventFilterDisabledFor: "",
};

const VISIBLE_FILTER_DEFAULTS = {
    gameFilter: "all",
    eventFilter: "none",
    gameDateFilter: "all",
    favouritesOnly: false,
};

export function hasActiveFilters({ includeFavourites = true } = {}) {
    return Object.entries(VISIBLE_FILTER_DEFAULTS).some(([key, value]) =>
        (includeFavourites || key !== "favouritesOnly") && state[key] !== value
    );
}

function storage() {
    try {
        return typeof sessionStorage === "undefined" ? null : sessionStorage;
    } catch (_error) {
        return null;
    }
}

const sessionStore = storage();
if (sessionStore) {
    try {
        const saved = JSON.parse(sessionStore.getItem(STORAGE_KEY) || "null");
        if (saved && typeof saved === "object") {
            Object.keys(FILTER_DEFAULTS).forEach((key) => {
                if (typeof saved[key] === typeof FILTER_DEFAULTS[key]) state[key] = saved[key];
            });
        }
    } catch (_error) {
        clearFilterSession();
    }
}

export function saveFilterSession() {
    const target = storage();
    if (!target) return;
    try {
        target.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(
            Object.keys(FILTER_DEFAULTS).map((key) => [key, state[key]])
        )));
    } catch (_error) {
        // Filters still work for the current page when storage is unavailable.
    }
}

export function clearFilterSession() {
    Object.assign(state, FILTER_DEFAULTS);
    try {
        storage()?.removeItem(STORAGE_KEY);
    } catch (_error) {
        // The in-memory filters have still been reset.
    }
}

function eventKey(event) {
    return event?.id || event?.name || event?.label || "";
}

export function activeEventKey(events, now = new Date()) {
    const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (Number.isNaN(currentTime)) return "";

    const activeEvent = (events || []).find((event) =>
        (event?.ranges || []).some((range) => {
            const start = new Date(range?.start).getTime();
            const end = new Date(range?.end).getTime();
            return !Number.isNaN(start) && !Number.isNaN(end) &&
                currentTime >= start && currentTime <= end;
        })
    );
    return eventKey(activeEvent);
}

export function applyInitialEventFilter(events, now = new Date()) {
    const currentEvent = activeEventKey(events, now);
    if (!currentEvent || state.autoEventFilterDisabledFor === currentEvent) return false;

    Object.assign(state, VISIBLE_FILTER_DEFAULTS, {
        eventFilter: currentEvent,
        autoEventFilterDisabledFor: "",
    });
    saveFilterSession();
    return true;
}

export function rememberAutoEventFilterChoice(events, selectedEvent, now = new Date()) {
    const currentEvent = activeEventKey(events, now);
    if (!currentEvent) return false;
    state.autoEventFilterDisabledFor = selectedEvent === currentEvent ? "" : currentEvent;
    return true;
}
