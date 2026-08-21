import { KEYBOARD_SHORTCUT_HINTS_QUERY } from "./config.js";

let shortcutHintsMediaQuery = null;

function shortcutHintsVisible() {
    return typeof window.matchMedia === "function" &&
        window.matchMedia(KEYBOARD_SHORTCUT_HINTS_QUERY).matches;
}

export function setShortcutTooltip(element, baseTitle) {
    if (!element) return;
    const title = String(baseTitle || "");
    const shortcut = element.dataset.keyboardShortcut;
    element.dataset.tooltipBase = title;
    element.title = shortcut && !element.disabled && shortcutHintsVisible()
        ? `${title} (${shortcut})`
        : title;
}

function refreshShortcutTooltips() {
    document.querySelectorAll("[data-keyboard-shortcut]").forEach((element) => {
        setShortcutTooltip(element, element.dataset.tooltipBase ?? element.title);
    });
}

export function setupShortcutTooltips() {
    if (!shortcutHintsMediaQuery && typeof window.matchMedia === "function") {
        shortcutHintsMediaQuery = window.matchMedia(KEYBOARD_SHORTCUT_HINTS_QUERY);
        if (typeof shortcutHintsMediaQuery.addEventListener === "function") {
            shortcutHintsMediaQuery.addEventListener("change", refreshShortcutTooltips);
        } else {
            shortcutHintsMediaQuery.addListener(refreshShortcutTooltips);
        }
    }
    refreshShortcutTooltips();
}
