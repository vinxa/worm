// @ts-check

const logoDances = [
    { name: "worm-spin", duration: "1.1s", easing: "ease-in-out" },
    { name: "worm-corkscrew", duration: "1s", easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    { name: "worm-burrow-boing", duration: "1.15s", easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    { name: "dance1", duration: "0.8s", easing: "ease-in-out" },
    { name: "dance2", duration: "0.8s", easing: "ease-in-out" },
    { name: "dance3", duration: "0.8s", easing: "ease-in-out" },
];
const previousDanceIndexes = new WeakMap();

/** @param {HTMLElement} logo */
export function playRandomLogoDance(logo) {
    const previousDanceIndex = previousDanceIndexes.get(logo) ?? -1;
    const dances = logoDances.filter((_, index) => index !== previousDanceIndex);
    const dance = dances[Math.floor(Math.random() * dances.length)];

    previousDanceIndexes.set(logo, logoDances.indexOf(dance));
    logo.classList.remove("wiggle-on-load");
    logo.style.animation = "";
    void logo.offsetWidth;
    logo.style.animation = `${dance.name} ${dance.duration} ${dance.easing}`;
}

/** @param {string} selector */
export function wiggleMatchingLogos(selector) {
    document.querySelectorAll(selector).forEach((logo) => {
        if (logo instanceof HTMLElement) playRandomLogoDance(logo);
    });
}

export function wiggleLogos() {
    wiggleMatchingLogos(".app-logo");
}

/**
 * @param {HTMLElement} logo
 * @param {{hotkeyTarget?: Document}} [options]
 * @returns {() => void}
 */
export function setupLogoDance(logo, { hotkeyTarget } = {}) {
    const dance = () => playRandomLogoDance(logo);
    const clear = () => { logo.style.animation = ""; };
    /** @param {KeyboardEvent} event */
    const handleHotkey = (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (event.code !== "KeyW" || event.ctrlKey || event.metaKey || event.altKey
            || ["INPUT", "TEXTAREA"].includes(target?.tagName || "") || target?.isContentEditable) return;
        event.preventDefault();
        dance();
    };
    logo.addEventListener("mouseenter", dance);
    logo.addEventListener("animationend", clear);
    hotkeyTarget?.addEventListener("keydown", handleHotkey);
    return () => {
        logo.removeEventListener("mouseenter", dance);
        logo.removeEventListener("animationend", clear);
        hotkeyTarget?.removeEventListener("keydown", handleHotkey);
    };
}
