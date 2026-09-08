function naturalTitleWidth(title) {
    const properties = ["width", "max-width", "flex", "white-space"];
    const previous = properties.map((property) => [
        property, title.style.getPropertyValue(property), title.style.getPropertyPriority(property),
    ]);
    try {
        title.style.setProperty("width", "max-content", "important");
        title.style.setProperty("max-width", "none", "important");
        title.style.setProperty("flex", "none", "important");
        title.style.setProperty("white-space", "nowrap", "important");
        return title.getBoundingClientRect().width;
    } finally {
        previous.forEach(([property, value, priority]) => {
            if (value) title.style.setProperty(property, value, priority);
            else title.style.removeProperty(property);
        });
    }
}

function visibleControlBounds(element) {
    const controls = element.matches(".header-left, .header-right, .game-layout-toolbar")
        ? [...element.children] : [element];
    return controls.flatMap((control) => {
        const style = getComputedStyle(control);
        if (style.display === "none" || style.visibility !== "visible") return [];
        const rect = control.getBoundingClientRect();
        return rect.width && rect.height ? [rect] : [];
    });
}

export function setupGameHeaderTitle(header = document.querySelector("body > .app-header")) {
    const title = header?.querySelector(":scope > .title");
    if (!title) return () => {};
    let frame = null;
    const update = () => {
        frame = null;
        if (!document.body.classList.contains("game-view-active") ||
            !header.getBoundingClientRect().width || getComputedStyle(title).display === "none") {
            title.classList.remove("header-title-centered");
            return;
        }
        const width = naturalTitleWidth(title);
        const bounds = header.getBoundingClientRect();
        const style = getComputedStyle(header);
        const center = bounds.left + bounds.width / 2;
        let left = bounds.left + parseFloat(style.paddingLeft);
        let right = bounds.right - parseFloat(style.paddingRight);
        let beforeTitle = true;
        for (const child of header.children) {
            if (child === title) {
                beforeTitle = false;
                continue;
            }
            for (const rect of visibleControlBounds(child)) {
                if (beforeTitle) left = Math.max(left, rect.right);
                else right = Math.min(right, rect.left);
            }
        }
        const gap = Math.max(4, parseFloat(style.columnGap) || 0);
        const available = 2 * Math.min(center - left - gap, right - center - gap);
        title.classList.toggle("header-title-centered", width <= available);
    };
    const schedule = () => {
        if (frame === null) frame = requestAnimationFrame(update);
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(header);
    [...header.children].forEach((element) => resizeObserver?.observe(element));
    const mutationObserver = new MutationObserver((records) => {
        // Measuring intrinsic width and centering update this element's style
        // and class only. Content and control changes still trigger a recheck.
        if (records.some((record) => record.target !== title || record.type !== "attributes")) schedule();
    });
    mutationObserver.observe(header, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["hidden", "class", "style"],
    });
    mutationObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    schedule();
    return () => {
        if (frame !== null) cancelAnimationFrame(frame);
        resizeObserver?.disconnect();
        mutationObserver.disconnect();
        window.removeEventListener("resize", schedule);
        document.fonts?.removeEventListener("loadingdone", schedule);
        title.classList.remove("header-title-centered");
    };
}
