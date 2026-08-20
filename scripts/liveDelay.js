import { LIVE_PRESENTATION_DELAY_SECONDS } from "./config.js";
import { withLocalStorage } from "./browserStorage.js";

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

let livePresentationDelaySeconds = normaliseLivePresentationDelay(
    withLocalStorage((storage) => storage.getItem(LIVE_PRESENTATION_DELAY_STORAGE_KEY)),
);

export function getLivePresentationDelaySeconds() {
    return livePresentationDelaySeconds;
}

export function setLivePresentationDelaySeconds(value) {
    livePresentationDelaySeconds = normaliseLivePresentationDelay(
        value,
        livePresentationDelaySeconds,
    );
    withLocalStorage((storage) =>
        storage.setItem(
            LIVE_PRESENTATION_DELAY_STORAGE_KEY,
            String(livePresentationDelaySeconds),
        )
    );
    window.dispatchEvent(new CustomEvent(LIVE_PRESENTATION_DELAY_CHANGE_EVENT, {
        detail: { seconds: livePresentationDelaySeconds },
    }));
    return livePresentationDelaySeconds;
}
