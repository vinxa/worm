import { withLocalStorage } from "./browserStorage.js";
import { state } from "./state.js";

export const GAME_LAYOUT_STORAGE_KEY = "worm:game-layout-timeline-ratio";

const MIN_SAVED_RATIO = 0.1;
const MAX_SAVED_RATIO = 0.9;
const KEYBOARD_STEP_PX = 16;
const LARGE_KEYBOARD_STEP_PX = 48;

let preferredTimelineRatio = null;
let resizeFrame = null;
let chartFrame = null;
let resizerElement = null;
let pointerIsDown = false;
let pointerHasMoved = false;
let pendingPointerClientY = null;
let pointerCaptureElement = null;
let layoutChangeCallback = null;

export function normaliseTimelineRatio(value) {
    if (value === null || value === undefined || value === "") return null;
    const ratio = Number(value);
    if (!Number.isFinite(ratio)) return null;
    return Math.min(MAX_SAVED_RATIO, Math.max(MIN_SAVED_RATIO, ratio));
}

function readSavedRatio() {
    return normaliseTimelineRatio(withLocalStorage(
        (storage) => storage.getItem(GAME_LAYOUT_STORAGE_KEY),
        null,
    ));
}

function storeRatio(ratio) {
    withLocalStorage((storage) => storage.setItem(GAME_LAYOUT_STORAGE_KEY, String(ratio)));
}

function clearStoredRatio() {
    withLocalStorage((storage) => storage.removeItem(GAME_LAYOUT_STORAGE_KEY));
}

function getElements() {
    const header = document.querySelector("body > .app-header");
    const timelineSection = document.querySelector("body > .timeline-section");
    return { header, timelineSection };
}

export function getTimelineBounds(availableHeight) {
    const available = Math.max(0, Number(availableHeight) || 0);
    let minimumResults = Math.min(160, Math.max(72, Math.round(available * 0.22)));
    let minimumTimeline = Math.min(180, Math.max(90, Math.round(available * 0.25)));

    if (minimumResults + minimumTimeline > available) {
        minimumResults = Math.floor(available * 0.45);
        minimumTimeline = Math.floor(available * 0.45);
    }

    return {
        available,
        minimum: Math.max(0, minimumTimeline),
        maximum: Math.max(minimumTimeline, available - minimumResults),
    };
}

function getLayoutMetrics() {
    const { header } = getElements();
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const headerBottom = header?.getBoundingClientRect().bottom || 0;
    const dividerHeight = resizerElement?.getBoundingClientRect().height || 0;
    const bounds = getTimelineBounds(viewportHeight - headerBottom - dividerHeight);
    return { ...bounds, viewportHeight, headerBottom, dividerHeight };
}

function clampTimelineHeight(height, bounds) {
    return Math.min(bounds.maximum, Math.max(bounds.minimum, height));
}

function updateAccessibility(height, bounds = getLayoutMetrics()) {
    if (!resizerElement || !bounds.available) return;
    const timelinePercent = Math.round((height / bounds.available) * 100);
    const resultsPercent = 100 - timelinePercent;
    resizerElement.setAttribute("aria-valuemin", String(Math.round(
        (bounds.minimum / bounds.available) * 100,
    )));
    resizerElement.setAttribute("aria-valuemax", String(Math.round(
        (bounds.maximum / bounds.available) * 100,
    )));
    resizerElement.setAttribute("aria-valuenow", String(timelinePercent));
    resizerElement.setAttribute(
        "aria-valuetext",
        `Timeline ${timelinePercent}%, player results ${resultsPercent}%`,
    );
}

function queueChartReflow() {
    if (chartFrame !== null) return;
    chartFrame = requestAnimationFrame(() => {
        chartFrame = null;
        state.chart?.reflow?.();
    });
}

function notifyLayoutChange() {
    layoutChangeCallback?.();
    document.dispatchEvent(new CustomEvent("worm:timeline-layout-change", {
        detail: { ratio: preferredTimelineRatio },
    }));
}

export function setGameTimelineRatio(value) {
    const ratio = normaliseTimelineRatio(value);
    if (ratio === null) {
        resetGameLayout();
        return;
    }
    preferredTimelineRatio = ratio;
    storeRatio(ratio);
    applyRatio(ratio);
}

export function getGameTimelineRatio() {
    return preferredTimelineRatio;
}

function setTimelineHeight(height, { persist = false, updatePreference = true } = {}) {
    const bounds = getLayoutMetrics();
    if (!bounds.available) return null;
    const nextHeight = clampTimelineHeight(height, bounds);
    const ratio = nextHeight / bounds.available;

    document.body.classList.add("game-layout-custom");
    document.body.style.setProperty("--game-timeline-size", `${nextHeight}px`);
    if (updatePreference) preferredTimelineRatio = ratio;
    updateAccessibility(nextHeight, bounds);
    queueChartReflow();
    notifyLayoutChange();

    if (persist) storeRatio(ratio);
    return nextHeight;
}

function applyRatio(ratio, options) {
    const bounds = getLayoutMetrics();
    if (!bounds.available) return null;
    return setTimelineHeight(bounds.available * ratio, {
        ...options,
        updatePreference: false,
    });
}

function currentTimelineHeight() {
    const { timelineSection } = getElements();
    return timelineSection?.getBoundingClientRect().height || 0;
}

function syncDefaultAccessibility() {
    requestAnimationFrame(() => {
        const bounds = getLayoutMetrics();
        updateAccessibility(currentTimelineHeight(), bounds);
    });
}

export function resetGameLayout() {
    preferredTimelineRatio = null;
    document.body.classList.remove("game-layout-custom", "game-layout-resizing");
    document.body.style.removeProperty("--game-timeline-size");
    resizerElement?.classList.remove("is-resizing");
    clearStoredRatio();
    syncDefaultAccessibility();
    queueChartReflow();
    notifyLayoutChange();
}

export function applySavedGameLayout() {
    preferredTimelineRatio = readSavedRatio();
    if (preferredTimelineRatio === null) {
        document.body.classList.remove("game-layout-custom");
        document.body.style.removeProperty("--game-timeline-size");
        syncDefaultAccessibility();
        return;
    }
    applyRatio(preferredTimelineRatio);
}

function updateFromPointer(clientY, { persist = false } = {}) {
    const bounds = getLayoutMetrics();
    const height = bounds.viewportHeight - clientY - (bounds.dividerHeight / 2);
    return setTimelineHeight(height, { persist });
}

function finishPointerResize(event) {
    if (!pointerIsDown) return;
    if (pointerHasMoved && pendingPointerClientY !== null) {
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
        updateFromPointer(pendingPointerClientY);
    }
    pointerIsDown = false;
    pendingPointerClientY = null;
    document.body.classList.remove("game-layout-resizing");
    resizerElement?.classList.remove("is-resizing");
    const captureElement = pointerCaptureElement;
    pointerCaptureElement = null;
    try {
        if (captureElement?.hasPointerCapture?.(event.pointerId)) {
            captureElement.releasePointerCapture(event.pointerId);
        }
    } catch {
        // Synthetic pointer events and older browsers may not own a capture.
    }
    if (pointerHasMoved && preferredTimelineRatio !== null) {
        storeRatio(preferredTimelineRatio);
    }
}

function handlePointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const grip = event.target.closest?.(".game-layout-resizer-grip");
    if (!grip) return;
    pointerIsDown = true;
    pointerHasMoved = false;
    pendingPointerClientY = null;
    pointerCaptureElement = grip;
    document.body.classList.add("game-layout-resizing");
    resizerElement.classList.add("is-resizing");
    resizerElement.focus({ preventScroll: true });
    try {
        grip.setPointerCapture?.(event.pointerId);
    } catch {
        // Pointer capture is an enhancement; window listeners remain the fallback.
    }
}

function handleDoubleClick(event) {
    if (!event.target.closest?.(".game-layout-resizer-grip")) return;
    resetGameLayout();
}

function handlePointerMove(event) {
    if (!pointerIsDown) return;
    pointerHasMoved = true;
    pendingPointerClientY = event.clientY;
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        updateFromPointer(pendingPointerClientY);
    });
    event.preventDefault();
}

function handleKeyDown(event) {
    const bounds = getLayoutMetrics();
    const step = event.shiftKey ? LARGE_KEYBOARD_STEP_PX : KEYBOARD_STEP_PX;
    const currentHeight = currentTimelineHeight();
    let nextHeight = null;

    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        nextHeight = currentHeight + step;
    } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        nextHeight = currentHeight - step;
    } else if (event.key === "Home") {
        nextHeight = bounds.minimum;
    } else if (event.key === "End") {
        nextHeight = bounds.maximum;
    } else {
        return;
    }

    setTimelineHeight(nextHeight, { persist: true });
    event.preventDefault();
}

function handleViewportResize() {
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (preferredTimelineRatio !== null && document.body.classList.contains("game-layout-custom")) {
            applyRatio(preferredTimelineRatio);
        } else {
            updateAccessibility(currentTimelineHeight());
        }
    });
}

export function setupGameLayoutResizer({ onLayoutChange = null } = {}) {
    layoutChangeCallback = onLayoutChange;
    resizerElement = document.getElementById("gameLayoutResizer");
    if (!resizerElement || resizerElement.dataset.layoutResizerReady === "true") return;
    resizerElement.dataset.layoutResizerReady = "true";

    resizerElement.addEventListener("pointerdown", handlePointerDown);
    resizerElement.addEventListener("dblclick", handleDoubleClick);
    resizerElement.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", finishPointerResize);
    window.addEventListener("pointercancel", finishPointerResize);
    window.addEventListener("resize", handleViewportResize);
}
