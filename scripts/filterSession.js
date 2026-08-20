import { state } from "./state.js";
import { withSessionStorage } from "./browserStorage.js";

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

const savedFilters = withSessionStorage((storage) =>
    JSON.parse(storage.getItem(STORAGE_KEY) || "null"),
    null,
    clearFilterSession,
);
if (savedFilters && typeof savedFilters === "object") {
    Object.keys(FILTER_DEFAULTS).forEach((key) => {
        if (typeof savedFilters[key] === typeof FILTER_DEFAULTS[key]) {
            state[key] = savedFilters[key];
        }
    });
}

export function saveFilterSession() {
    withSessionStorage((storage) =>
        storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(
            Object.keys(FILTER_DEFAULTS).map((key) => [key, state[key]])
        )))
    );
}

export function clearFilterSession() {
    Object.assign(state, FILTER_DEFAULTS);
    withSessionStorage((storage) => storage.removeItem(STORAGE_KEY));
}

export function eventKey(event) {
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
