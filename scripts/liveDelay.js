import { LIVE_PRESENTATION_DELAY_SECONDS } from "./config.js";

export const LIVE_PRESENTATION_DELAY_CHANGE_EVENT = "worm:live-presentation-delay-change";
const LIVE_PRESENTATION_DELAY_STORAGE_KEY = "worm:live-presentation-delay-seconds";
const MAX_LIVE_PRESENTATION_DELAY_SECONDS = 5;

export function normaliseLivePresentationDelay(
    value,
    fallback = LIVE_PRESENTATION_DELAY_SECONDS,
) {
    if (value === null || String(value).trim() === "") return fallback;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return fallback;
    return Math.min(seconds, MAX_LIVE_PRESENTATION_DELAY_SECONDS);
}

function loadLivePresentationDelay() {
    try {
        return normaliseLivePresentationDelay(
            window.localStorage.getItem(LIVE_PRESENTATION_DELAY_STORAGE_KEY),
        );
    } catch {
        return LIVE_PRESENTATION_DELAY_SECONDS;
    }
}

let livePresentationDelaySeconds = loadLivePresentationDelay();

export function getLivePresentationDelaySeconds() {
    return livePresentationDelaySeconds;
}

export function setLivePresentationDelaySeconds(value) {
    livePresentationDelaySeconds = normaliseLivePresentationDelay(
        value,
        livePresentationDelaySeconds,
    );
    try {
        window.localStorage.setItem(
            LIVE_PRESENTATION_DELAY_STORAGE_KEY,
            String(livePresentationDelaySeconds),
        );
    } catch {
        // Keep the preference for this page lifetime when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(LIVE_PRESENTATION_DELAY_CHANGE_EVENT, {
        detail: { seconds: livePresentationDelaySeconds },
    }));
    return livePresentationDelaySeconds;
}
