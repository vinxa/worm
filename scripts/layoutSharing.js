import { DOCK_PANEL_IDS } from "./layoutDocking.js";

const URL_LAYOUT_VERSION = 1;
const MAX_LAYOUT_LENGTH = 2048;
const MAX_TREE_DEPTH = DOCK_PANEL_IDS.length - 1;
const PANEL_IDS = new Set(DOCK_PANEL_IDS);

// Compact links store only the dock tree: panel names are leaves and splits
// are [axis, ratio, first, second]. Missing panels are hidden, including video.
function transformTree(tree, compactInput) {
    const usedPanels = new Set();
    function visit(node, depth = 0) {
        if (depth > MAX_TREE_DEPTH) return undefined;
        if (typeof node === "string") {
            if (!PANEL_IDS.has(node) || usedPanels.has(node)) return undefined;
            usedPanels.add(node);
            return node;
        }
        if (!node || typeof node !== "object") return undefined;
        if (compactInput ? !Array.isArray(node) || node.length !== 4 : Array.isArray(node)) {
            return undefined;
        }
        const [axis, ratio, first, second] = compactInput
            ? node : [node.axis, node.ratio, node.first, node.second];
        // Match the docking model's persistence bounds without rounding a
        // sender's split or silently repairing a malformed shared layout.
        if ((axis !== "x" && axis !== "y") || typeof ratio !== "number" ||
            !Number.isFinite(ratio) || ratio < 0.01 || ratio > 0.99) return undefined;
        const nextFirst = visit(first, depth + 1);
        if (nextFirst === undefined) return undefined;
        const nextSecond = visit(second, depth + 1);
        if (nextSecond === undefined) return undefined;
        return compactInput
            ? { axis, ratio, first: nextFirst, second: nextSecond }
            : [axis, ratio, nextFirst, nextSecond];
    }
    return { tree: tree === null ? null : visit(tree), videoVisible: usedPanels.has("video") };
}

export function serialiseGameLayout(layout) {
    if (!layout || typeof layout !== "object" || Array.isArray(layout) ||
        (layout.version !== undefined && layout.version !== 3) || !("tree" in layout)) return "";
    const { tree } = transformTree(layout.tree, false);
    return tree === undefined ? "" : JSON.stringify([URL_LAYOUT_VERSION, tree]);
}

export function parseGameLayout(value) {
    if (typeof value !== "string" || !value || value.length > MAX_LAYOUT_LENGTH) return null;
    let payload;
    try { payload = JSON.parse(value); } catch { return null; }
    if (!Array.isArray(payload) || payload.length !== 2 || payload[0] !== URL_LAYOUT_VERSION) return null;
    const { tree, videoVisible } = transformTree(payload[1], true);
    return tree === undefined ? null : { version: 3, tree, video: { visible: videoVisible, mode: "docked" } };
}
