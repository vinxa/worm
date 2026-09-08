import { withLocalStorage } from "./browserStorage.js";
import { state } from "./state.js";
import { DESKTOP_TIMELINE_QUERY } from "./config.js";
import { setShortcutTooltip } from "./shortcutTooltips.js";
import { normaliseDockTree, removeDockPanel, dockPanel, getDockLayout, resizeDockSplit } from "./layoutDocking.js";

export const GAME_LAYOUT_PREFERENCES_KEY = "worm:game-layout-docking";
const LEGACY_KEY = "worm:game-layout";
const LEGACY_RATIO_KEY = "worm:game-layout-timeline-ratio";
const PANELS = { players: "Player tiles", teams: "Team tiles", timeline: "Timeline", video: "Video" };
const DEFAULT_TREE = {
    axis: "y", ratio: 0.5,
    first: { axis: "x", ratio: 0.78, first: "players", second: "teams" }, second: "timeline",
};

function defaultDockTree() {
    const first = { ...DEFAULT_TREE.first };
    if (window.matchMedia(DESKTOP_TIMELINE_QUERY).matches) {
        // Keep the default totals sidebar close to its compact 140px width.
        // Saved arrangements still retain their own divider positions.
        const availableWidth = Math.max(1, window.innerWidth - 36);
        first.ratio = 1 - 140 / availableWidth;
    }
    return { ...DEFAULT_TREE, first };
}
const panelIds = (tree) => !tree ? [] : typeof tree === "string" ? [tree] : [...panelIds(tree.first), ...panelIds(tree.second)];

export function normaliseGameLayout(value) {
    const source = value && typeof value === "object" ? value : {};
    const video = {
        visible: source.video?.visible === true,
        mode: "docked",
    };
    let tree = source.tree === null ? null : normaliseDockTree(source.tree) || normaliseDockTree(defaultDockTree());
    // Preserve visibility when migrating the earlier browser preferences.
    if (!("tree" in source)) {
        for (const id of ["players", "teams", "timeline"]) {
            if (source[id]?.visible === false) tree = removeDockPanel(tree, id);
        }
    }
    if (!video.visible) tree = removeDockPanel(tree, "video");
    else if (!panelIds(tree).includes("video")) tree = dockPanel(tree, "video", null, "right");
    return { version: 3, tree, video };
}

function readPreferences() {
    return withLocalStorage((storage) => {
        try {
            return normaliseGameLayout(JSON.parse(storage.getItem(GAME_LAYOUT_PREFERENCES_KEY) ?? storage.getItem(LEGACY_KEY)));
        } catch { return normaliseGameLayout(); }
    }, normaliseGameLayout());
}

let preferences = readPreferences();
let sharedLayout = false;
let layoutCallback, videoCallback, workspace;
let layoutFrame = null, pointerFrame = null, pendingMove = null, action = null;
let layoutMode = false;
let panels = {};
let layout = { panels: {}, splitters: [] };

function canEditLayout() {
    return layoutMode && document.body.classList.contains("game-view-active");
}

export function setGameLayoutMode(enabled) {
    const nextMode = Boolean(enabled) && document.body.classList.contains("game-view-active");
    const restoreToggleFocus = !nextMode && document.activeElement?.closest(
        ".panel-chrome, .panel-resize-handle, .dock-splitter, #gameLayoutToolbar"
    );
    if (!nextMode) finishPointer({}, true);
    layoutMode = nextMode;
    document.body.classList.toggle("layout-mode", nextMode);
    const button = document.getElementById("gameLayoutButton");
    if (button) {
        button.setAttribute("aria-pressed", String(nextMode));
        setShortcutTooltip(button, nextMode ? "Finish editing layout" : "Edit layout");
    }
    const toolbar = document.getElementById("gameLayoutToolbar");
    if (toolbar) toolbar.hidden = !nextMode;
    for (const control of document.querySelectorAll(".panel-drag-handle, .panel-hide, .panel-resize-handle, #gameLayoutToolbar button")) {
        control.tabIndex = nextMode ? 0 : -1;
        if (control instanceof HTMLButtonElement) control.disabled = !nextMode;
    }
    setShortcutTooltip(document.getElementById("gameLayoutReset"), "Reset layout");
    if (restoreToggleFocus) {
        button?.focus({ preventScroll: true });
    }
    renderLayout();
}

export function resetGameLayout() {
    if (!document.body.classList.contains("game-view-active")) return;
    finishPointer({}, true);
    preferences = normaliseGameLayout();
    sharedLayout = false;
    withLocalStorage((storage) => {
        for (const key of [GAME_LAYOUT_PREFERENCES_KEY, LEGACY_KEY, LEGACY_RATIO_KEY]) storage.removeItem(key);
    });
    applyGameLayoutPreferences();
    announce("Layout reset.");
}

function savePreferences() {
    sharedLayout = false;
    withLocalStorage((storage) => storage.setItem(GAME_LAYOUT_PREFERENCES_KEY, JSON.stringify(preferences)));
}

export function getGameLayoutPreferences() {
    return normaliseGameLayout(preferences);
}

export function restoreGameLayoutForView(gameLayout) {
    if (gameLayout || sharedLayout) {
        finishPointer({}, true);
        preferences = gameLayout ? normaliseGameLayout(gameLayout) : readPreferences();
        sharedLayout = Boolean(gameLayout);
        setGameLayoutMode(false);
    }
    // A shared link overrides this view without replacing browser preferences.
    // The next explicit layout edit saves through the usual controls.
    applyGameLayoutPreferences();
}

function announce(message) {
    const output = document.getElementById("gameLayoutAnnouncement");
    if (output) output.textContent = message;
}

function applyRect(element, rect) {
    for (const [property, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })) {
        element.style[property] = `${value}px`;
    }
}

function refreshContent() {
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
        layoutFrame = null;
        layoutCallback?.();
        state.chart?.reflow?.();
    });
}

function renderSplitters() {
    const existing = new Map([...workspace.querySelectorAll(".dock-splitter")].map((element) => [element.dataset.path, element]));
    for (const split of layout.splitters) {
        const key = split.path.join(".");
        let element = existing.get(key);
        if (!element) {
            element = document.createElement("button");
            element.type = "button";
            element.dataset.path = key;
            element.setAttribute("role", "separator");
            element.setAttribute("aria-label", "Resize neighbouring panels");
            element.addEventListener("pointerdown", (event) => beginResize(event, element.dataset.path));
            element.addEventListener("keydown", (event) => {
                if (!canEditLayout()) return;
                const current = layout.splitters.find((item) => item.path.join(".") === element.dataset.path);
                if (!current) return;
                const step = event.shiftKey ? 0.1 : 0.025;
                const delta = { ArrowLeft: -step, ArrowUp: -step, ArrowRight: step, ArrowDown: step }[event.key];
                if (delta === undefined && event.key !== "Home" && event.key !== "End") return;
                event.preventDefault();
                preferences.tree = resizeDockSplit(preferences.tree, current.path,
                    event.key === "Home" ? current.minRatio : event.key === "End" ? current.maxRatio : current.ratio + delta);
                savePreferences();
                renderLayout();
            });
            workspace.append(element);
        }
        existing.delete(key);
        element.hidden = !canEditLayout();
        element.disabled = !canEditLayout();
        element.className = `dock-splitter dock-splitter-${split.axis}`;
        element.setAttribute("aria-orientation", split.axis === "x" ? "vertical" : "horizontal");
        element.setAttribute("aria-valuemin", Math.round(split.minRatio * 100));
        element.setAttribute("aria-valuemax", Math.round(split.maxRatio * 100));
        element.setAttribute("aria-valuenow", Math.round(split.ratio * 100));
        element.title = "Drag to resize panels, or use arrow keys";
        applyRect(element, split.rect);
    }
    existing.forEach((element) => element.remove());
}

function renderLayout() {
    if (!workspace || !document.body.classList.contains("game-view-active")) {
        if (action) finishPointer({}, true);
        if (layoutMode) setGameLayoutMode(false);
        return;
    }
    // Tray buttons can wrap the toolbar. Update them before measuring the
    // board, including when several layout changes occur in the same frame.
    const visiblePanels = new Set(panelIds(preferences.tree));
    for (const button of document.querySelectorAll("[data-layout-add]")) {
        const id = button.dataset.layoutAdd;
        button.hidden = id === "video" ? preferences.video.visible : visiblePanels.has(id);
    }
    const bounds = workspace.getBoundingClientRect();
    layout = getDockLayout(preferences.tree, {
        x: bounds.left + 6, y: bounds.top + 6,
        width: Math.max(0, bounds.width - 12), height: Math.max(0, bounds.height - 12),
    }, 8);
    for (const [id, element] of Object.entries(panels)) {
        const rect = layout.panels[id];
        element.hidden = !rect;
        element.classList.toggle("dock-panel", Boolean(rect));
        if (rect) applyRect(element, rect);
        const resize = element.querySelector(".panel-resize-handle");
        if (resize) resize.hidden = !canEditLayout() || !rect || !layout.splitters.length;
    }
    renderSplitters();
    const empty = document.getElementById("gameLayoutEmpty");
    empty.hidden = Boolean(preferences.tree);
    empty.textContent = layoutMode
        ? "Drag a panel from the top bar into this space, or select its button."
        : "All panels are hidden. Turn on Layout mode to add one.";
    refreshContent();
}

export function applyGameLayoutPreferences() {
    if (!workspace) return;
    document.body.classList.add("game-layout-board");
    document.body.classList.remove("game-layout-custom", "layout-hide-results", "layout-no-panels");
    document.body.style.removeProperty("--game-timeline-size");
    for (const id of Object.keys(PANELS)) document.body.classList.remove(`layout-hide-${id}`, `layout-scale-${id}`);
    videoCallback?.({ ...preferences.video, visible: preferences.video.visible && document.body.classList.contains("game-view-active") });
    renderLayout();
}

function commitDock(id, target, edge) {
    if (id === "video") preferences.video = { ...preferences.video, visible: true, mode: "docked" };
    preferences.tree = dockPanel(preferences.tree, id, target, edge);
    savePreferences();
    applyGameLayoutPreferences();
    announce(`${PANELS[id]} moved ${edge === "center" ? "to its new position" : `to the ${edge}`}.`);
}

function hidePanel(id) {
    if (!canEditLayout()) return;
    preferences.tree = removeDockPanel(preferences.tree, id);
    if (id === "video") preferences.video.visible = false;
    savePreferences();
    applyGameLayoutPreferences();
    document.querySelector(`[data-layout-add="${id}"]`)?.focus({ preventScroll: true });
    announce(`${PANELS[id]} hidden. Its toolbar button can restore it.`);
}

function findDrop(clientX, clientY, id) {
    const bounds = workspace.getBoundingClientRect();
    if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return null;
    const board = { x: bounds.left + 6, y: bounds.top + 6, width: bounds.width - 12, height: bounds.height - 12 };
    const edgeOf = (rect, threshold) => {
        const distances = { left: clientX - rect.x, right: rect.x + rect.width - clientX,
            top: clientY - rect.y, bottom: rect.y + rect.height - clientY };
        const edge = Object.keys(distances).sort((a, b) => distances[a] - distances[b])[0];
        return distances[edge] < threshold ? edge : "center";
    };
    if (!preferences.tree) return { target: null, edge: "center", rect: board };
    let target = Object.entries(layout.panels).find(([, rect]) => clientX >= rect.x && clientX <= rect.x + rect.width &&
        clientY >= rect.y && clientY <= rect.y + rect.height);
    const outerEdge = edgeOf(board, 18);
    if (outerEdge !== "center") target = [null, board];
    if (!target || target[0] === id) return null;
    const [targetId, rect] = target;
    let edge = targetId === null ? outerEdge : edgeOf(rect, Math.min(rect.width, rect.height) * 0.28);
    // A hidden panel has no existing position to swap with the target.
    if (edge === "center" && !layout.panels[id]) edge = "right";
    const preview = { ...rect };
    if (edge === "left" || edge === "right") {
        preview.width /= 2;
        if (edge === "right") preview.x += preview.width;
    } else if (edge === "top" || edge === "bottom") {
        preview.height /= 2;
        if (edge === "bottom") preview.y += preview.height;
    }
    return { target: targetId, edge, rect: preview };
}

function beginDrag(event, id) {
    if (!canEditLayout() || event.button !== 0 || action) return;
    if (event.target.closest("input, select, .panel-hide, #modalClose, .panel-resize-handle")) return;
    action = { type: "drag", id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, drop: null, handle: event.currentTarget };
    event.currentTarget.focus({ preventScroll: true });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic events. */ }
}

function beginResize(event, path, panelId = null) {
    if (!canEditLayout() || event.button !== 0 || action) return;
    let splits;
    if (panelId) {
        const containing = layout.splitters.filter((split) => {
            let node = preferences.tree;
            for (const part of split.path) node = node[part];
            return panelIds(node).includes(panelId);
        }).sort((a, b) => b.path.length - a.path.length);
        splits = ["x", "y"].map((axis) => containing.find((split) => split.axis === axis)).filter(Boolean);
    } else splits = layout.splitters.filter((split) => split.path.join(".") === path);
    if (!splits.length) return;
    action = { type: "resize", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        originalTree: preferences.tree, splits, panelId, handle: event.currentTarget };
    document.body.classList.add("layout-resizing");
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic events. */ }
    event.preventDefault();
}

function movePointer(event) {
    if (!action || event.pointerId !== action.pointerId) return;
    pendingMove = { clientX: event.clientX, clientY: event.clientY };
    if (pointerFrame !== null) return;
    pointerFrame = requestAnimationFrame(() => { pointerFrame = null; applyPointerMove(); });
}

function applyPointerMove() {
    if (!action || !pendingMove) return;
    const { clientX, clientY } = pendingMove;
    pendingMove = null;
    if (action.type === "resize") {
        let tree = action.originalTree;
        for (const split of action.splits) {
            let direction = 1;
            if (action.panelId) {
                let node = action.originalTree;
                for (const part of split.path) node = node[part];
                if (panelIds(node.second).includes(action.panelId)) direction = -1;
            }
            const delta = split.axis === "x" ? clientX - action.startX : clientY - action.startY;
            tree = resizeDockSplit(tree, split.path, split.ratio + direction * delta / Math.max(1, split.availableSize));
        }
        preferences.tree = tree;
        renderLayout();
        return;
    }
    if (!action.moved && Math.hypot(clientX - action.startX, clientY - action.startY) < 5) return;
    action.moved = true;
    document.body.classList.add("layout-dragging");
    panels[action.id].classList.add("is-dragging");
    const ghost = document.getElementById("dockDragGhost");
    ghost.hidden = false;
    ghost.textContent = PANELS[action.id];
    ghost.style.left = `${Math.min(clientX + 12, window.innerWidth - 130)}px`;
    ghost.style.top = `${Math.max(0, clientY - 30)}px`;
    action.drop = findDrop(clientX, clientY, action.id);
    const preview = document.getElementById("dockDropPreview");
    preview.hidden = !action.drop;
    if (action.drop) {
        applyRect(preview, action.drop.rect);
        preview.textContent = action.drop.edge === "center" && action.drop.target ? "Swap panels" : "Drop here";
    }
}

function finishPointer(event, cancelled = false) {
    if (!action || (event.pointerId !== undefined && event.pointerId !== action.pointerId)) return;
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    pointerFrame = null;
    if (!cancelled) applyPointerMove();
    const finished = action;
    action = null;
    pendingMove = null;
    try { if (finished.handle.hasPointerCapture(finished.pointerId)) finished.handle.releasePointerCapture(finished.pointerId); } catch { /* Synthetic events. */ }
    document.body.classList.remove("layout-dragging", "layout-resizing");
    Object.values(panels).forEach((element) => element.classList.remove("is-dragging"));
    for (const id of ["dockDropPreview", "dockDragGhost"]) {
        const element = document.getElementById(id);
        if (element) element.hidden = true;
    }
    if (finished.type === "drag" && finished.moved) {
        finished.handle.dataset.dragged = "true";
        setTimeout(() => delete finished.handle.dataset.dragged, 0);
    }
    if (cancelled && finished.type === "resize") {
        preferences.tree = finished.originalTree;
        renderLayout();
    } else if (finished.type === "resize") savePreferences();
    else if (!cancelled && finished.moved && finished.drop) {
        commitDock(finished.id, finished.drop.target, finished.drop.edge);
    }
}

function addDragBehaviour(handle, id) {
    handle.addEventListener("pointerdown", (event) => beginDrag(event, id));
    handle.addEventListener("keydown", (event) => {
        if (!canEditLayout()) return;
        const edge = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" }[event.key];
        if (!edge || event.target.closest("input, select, #modalClose")) return;
        event.preventDefault();
        commitDock(id, null, edge);
        handle.focus({ preventScroll: true });
    });
}

function setupPanel(id, element) {
    element.dataset.layoutPanel = id;
    let handle;
    if (id === "video") {
        handle = element.querySelector(".modal-header");
        handle.classList.add("panel-chrome");
        handle.tabIndex = 0;
        handle.classList.add("panel-drag-handle");
        handle.title = "Drag to move video. Arrow keys dock at an edge.";
        handle.setAttribute("aria-label", "Move video");
        const grip = document.createElement("span");
        grip.className = "panel-grip";
        grip.textContent = "⠿";
        grip.setAttribute("aria-hidden", "true");
        handle.prepend(grip);
    } else {
        if (id !== "timeline") {
            const content = document.createElement("div");
            content.className = "panel-content";
            content.append(...element.childNodes);
            element.append(content);
        }
        const chrome = document.createElement("header");
        chrome.className = "panel-chrome";
        handle = document.createElement("button");
        handle.type = "button";
        handle.className = "panel-drag-handle";
        const grip = document.createElement("span");
        grip.className = "panel-grip";
        grip.textContent = "⠿";
        grip.setAttribute("aria-hidden", "true");
        handle.append(grip, id === "players" ? "Players" : id === "teams" ? "Teams" : PANELS[id]);
        handle.title = `Drag to move ${PANELS[id].toLowerCase()}. Arrow keys dock at an edge.`;
        handle.setAttribute("aria-label", `Move ${PANELS[id].toLowerCase()}`);
        const hide = document.createElement("button");
        hide.type = "button";
        hide.className = "panel-hide";
        hide.textContent = "×";
        hide.setAttribute("aria-label", `Hide ${PANELS[id].toLowerCase()}`);
        hide.addEventListener("click", () => hidePanel(id));
        chrome.append(handle, hide);
        element.prepend(chrome);
    }
    addDragBehaviour(handle, id);
    const resize = document.createElement("button");
    resize.type = "button";
    resize.className = "panel-resize-handle";
    resize.setAttribute("aria-label", `Resize ${PANELS[id].toLowerCase()}`);
    resize.title = "Drag to resize. Use the dividers for keyboard resizing.";
    resize.addEventListener("pointerdown", (event) => beginResize(event, null, id));
    resize.addEventListener("keydown", (event) => {
        if (!canEditLayout()) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            workspace.querySelector(".dock-splitter")?.focus({ preventScroll: true });
        }
    });
    element.append(resize);
}

export function setupGameLayoutSettings({ onLayoutChange, onVideoLayoutChange } = {}) {
    layoutCallback = onLayoutChange;
    videoCallback = onVideoLayoutChange;
    workspace = document.getElementById("gameWorkspace");
    if (!workspace || workspace.dataset.ready) return;
    panels = {
        players: document.querySelector(".grid-container"), teams: document.querySelector(".scores-sidebar"),
        timeline: document.querySelector("body > .timeline-section"), video: document.getElementById("videoModal"),
    };
    if (Object.values(panels).some((element) => !element)) return;
    workspace.dataset.ready = "true";
    for (const [id, element] of Object.entries(panels)) setupPanel(id, element);
    const tray = document.getElementById("gameLayoutTray");
    for (const [id, label] of Object.entries(PANELS)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "layout-add";
        button.dataset.layoutAdd = id;
        button.textContent = `+ ${id === "players" ? "Players" : id === "teams" ? "Teams" : label}`;
        button.title = `Show ${label.toLowerCase()}, or drag it into the page`;
        button.addEventListener("click", () => {
            if (canEditLayout() && !button.dataset.dragged) commitDock(id, null, id === "timeline" ? "bottom" : "right");
        });
        addDragBehaviour(button, id);
        tray.append(button);
    }
    document.getElementById("gameLayoutReset").addEventListener("click", () => {
        if (!canEditLayout()) return;
        resetGameLayout();
    });
    document.getElementById("gameLayoutButton").addEventListener("click", (event) => {
        setGameLayoutMode(!layoutMode);
        // Release pointer focus so Space keeps controlling playback after a click.
        if (event.detail > 0 || event.pointerType) event.currentTarget.blur();
        announce(layoutMode ? "Layout mode. Drag panel headers to arrange and edges to resize." : "Layout mode off.");
    });
    document.addEventListener("worm:video-layout-change", (event) => {
        preferences.video = normaliseGameLayout({ ...preferences, video: { ...preferences.video, ...event.detail } }).video;
        if (preferences.video.visible) {
            if (!panelIds(preferences.tree).includes("video")) preferences.tree = dockPanel(preferences.tree, "video", null, "right");
        } else preferences.tree = removeDockPanel(preferences.tree, "video");
        savePreferences();
        applyGameLayoutPreferences();
    });
    window.addEventListener("pointermove", movePointer);
    window.addEventListener("pointerup", (event) => finishPointer(event));
    window.addEventListener("pointercancel", (event) => finishPointer(event, true));
    document.addEventListener("lostpointercapture", (event) => finishPointer(event, true), true);
    window.addEventListener("blur", () => finishPointer({}, true));
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && (action || canEditLayout())) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (action) finishPointer(event, true);
            else setGameLayoutMode(false);
        }
    }, true);
    window.addEventListener("storage", (event) => {
        if (sharedLayout) return;
        if (event.key !== GAME_LAYOUT_PREFERENCES_KEY && event.key !== null) return;
        finishPointer({}, true);
        preferences = readPreferences();
        applyGameLayoutPreferences();
    });
    window.addEventListener("resize", renderLayout);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(renderLayout).observe(workspace);
    setGameLayoutMode(false);
    applyGameLayoutPreferences();
}
