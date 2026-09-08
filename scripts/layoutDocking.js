export const DOCK_PANEL_IDS = Object.freeze(["players", "teams", "timeline", "video"]);

// Pixel minimums below keep panes usable; this wider persistence guard lets
// narrow sidebars keep their chosen width even on a large desktop.
const MIN_RATIO = 0.01;
const MAX_RATIO = 0.99;
const DEFAULT_RATIO = 0.5;
const PANEL_MINIMUMS = {
    players: { width: 96, height: 80 },
    teams: { width: 64, height: 80 },
    timeline: { width: 128, height: 80 },
    video: { width: 180, height: 96 },
};

function finiteNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normaliseRatio(value, fallback = DEFAULT_RATIO) {
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, finiteNumber(value, fallback)));
}

// A leaf is a panel ID. Invalid or duplicate leaves disappear, and a split
// with only one surviving child becomes that child.
export function normaliseDockTree(value, allowedPanels = DOCK_PANEL_IDS) {
    const suppliedPanels = Array.isArray(allowedPanels) || allowedPanels instanceof Set
        ? allowedPanels : DOCK_PANEL_IDS;
    const allowed = new Set(DOCK_PANEL_IDS.filter((id) => suppliedPanels.includes
        ? suppliedPanels.includes(id) : suppliedPanels.has(id)));
    const usedPanels = new Set();
    const visitedNodes = new WeakSet();

    function visit(node, depth = 0) {
        if (typeof node === "string") {
            if (!allowed.has(node) || usedPanels.has(node)) return null;
            usedPanels.add(node);
            return node;
        }
        if (!node || typeof node !== "object" || Array.isArray(node) ||
            visitedNodes.has(node) || depth > 32) return null;
        visitedNodes.add(node);
        const first = visit(node.first, depth + 1);
        const second = visit(node.second, depth + 1);
        if (!first) return second;
        if (!second) return first;
        return {
            axis: node.axis === "y" ? "y" : "x",
            ratio: normaliseRatio(node.ratio),
            first,
            second,
        };
    }

    return visit(value);
}

function removePanel(node, panelId) {
    if (!node || typeof node === "string") return node === panelId ? null : node;
    const first = removePanel(node.first, panelId);
    const second = removePanel(node.second, panelId);
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
}

export function removeDockPanel(tree, panelId) {
    return removePanel(normaliseDockTree(tree), panelId);
}

function hasPanel(node, panelId) {
    if (!node || typeof node === "string") return node === panelId;
    return hasPanel(node.first, panelId) || hasPanel(node.second, panelId);
}

function mapLeaves(node, map) {
    if (!node) return null;
    if (typeof node === "string") return map(node);
    return { ...node, first: mapLeaves(node.first, map), second: mapLeaves(node.second, map) };
}

// Move a pane beside another pane, or swap two existing panes on a center
// drop. A missing target inserts beside the whole board without losing panes.
export function dockPanel(tree, panelId, targetId, edge = "right") {
    const current = normaliseDockTree(tree);
    if (!DOCK_PANEL_IDS.includes(panelId)) return current;
    if (!current) return panelId;
    if (panelId === targetId) return current;
    const targetExists = hasPanel(current, targetId);
    if (edge === "center" && targetExists && hasPanel(current, panelId)) {
        return mapLeaves(current, (id) => id === panelId ? targetId : id === targetId ? panelId : id);
    }

    const remaining = removePanel(current, panelId);
    if (!remaining) return panelId;
    const axis = edge === "top" || edge === "bottom" ? "y" : "x";
    const insertFirst = edge === "left" || edge === "top";
    const insert = (target) => ({
        axis,
        ratio: DEFAULT_RATIO,
        first: insertFirst ? panelId : target,
        second: insertFirst ? target : panelId,
    });
    return targetExists ? mapLeaves(remaining, (id) => id === targetId ? insert(id) : id) : insert(remaining);
}

export function resizeDockSplit(tree, path, ratio) {
    const current = normaliseDockTree(tree);
    if (!Array.isArray(path) || path.some((part) => part !== "first" && part !== "second")) return current;

    function resize(node, depth) {
        if (!node || typeof node === "string") return node;
        if (depth === path.length) return { ...node, ratio: normaliseRatio(ratio, node.ratio) };
        const branch = path[depth];
        return { ...node, [branch]: resize(node[branch], depth + 1) };
    }

    return resize(current, 0);
}

// Bounds and gap use CSS pixels. Small boards share the available space
// proportionally, so even a board narrower than its divider stays nonnegative.
export function getDockLayout(tree, bounds = {}, gap = 8) {
    const root = normaliseDockTree(tree);
    const panels = {};
    const splitters = [];
    const rectangle = {
        x: finiteNumber(bounds?.x, 0),
        y: finiteNumber(bounds?.y, 0),
        width: Math.max(0, finiteNumber(bounds?.width, 0)),
        height: Math.max(0, finiteNumber(bounds?.height, 0)),
    };
    const desiredGap = Math.max(0, finiteNumber(gap, 8));

    // Ancestor dividers reserve space for every pane in a child subtree.
    // Measuring only its immediate child would starve nested panels even when
    // enough room exists elsewhere in the board.
    const minimumSizes = new Map();
    function measureMinimum(node) {
        if (typeof node === "string") return PANEL_MINIMUMS[node];
        if (minimumSizes.has(node)) return minimumSizes.get(node);
        const first = measureMinimum(node.first);
        const second = measureMinimum(node.second);
        const minimum = node.axis === "x"
            ? { width: first.width + desiredGap + second.width, height: Math.max(first.height, second.height) }
            : { width: Math.max(first.width, second.width), height: first.height + desiredGap + second.height };
        minimumSizes.set(node, minimum);
        return minimum;
    }

    function visit(node, rect, path) {
        if (!node) return;
        if (typeof node === "string") {
            panels[node] = rect;
            return;
        }
        const horizontal = node.axis === "x";
        const dimension = horizontal ? "width" : "height";
        const coordinate = horizontal ? "x" : "y";
        const actualGap = Math.min(desiredGap, rect[dimension]);
        const availableSize = rect[dimension] - actualGap;
        const firstMinimum = measureMinimum(node.first)[dimension];
        const secondMinimum = measureMinimum(node.second)[dimension];
        const combinedMinimum = firstMinimum + secondMinimum;
        const minimumsFit = availableSize >= combinedMinimum;
        const proportionalRatio = firstMinimum / combinedMinimum;
        const minRatio = minimumsFit ? firstMinimum / availableSize : proportionalRatio;
        const maxRatio = minimumsFit ? Math.max(minRatio, 1 - secondMinimum / availableSize) : proportionalRatio;
        const ratio = Math.min(maxRatio, Math.max(minRatio, node.ratio));
        const firstSize = availableSize * ratio;
        const firstRect = { ...rect, [dimension]: firstSize };
        const splitterRect = {
            ...rect,
            [coordinate]: rect[coordinate] + firstSize,
            [dimension]: actualGap,
        };
        const secondRect = {
            ...rect,
            [coordinate]: rect[coordinate] + firstSize + actualGap,
            [dimension]: availableSize - firstSize,
        };
        splitters.push({
            path: [...path],
            axis: node.axis,
            rect: splitterRect,
            ratio,
            minRatio,
            maxRatio,
            bounds: { ...rect },
            availableSize,
        });
        visit(node.first, firstRect, [...path, "first"]);
        visit(node.second, secondRect, [...path, "second"]);
    }

    visit(root, rectangle, []);
    return { panels, splitters };
}
