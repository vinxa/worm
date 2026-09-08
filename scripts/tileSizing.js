const CONTENT_SELECTOR = ":scope > :is(.player-summary-header, .player-summary-details, .team-name, .team-tags, .team-score)";
const TILE_SELECTOR = ".top-section :is(.player-summary, .team-scores li)";
let resizeObserver = null;

// Recheck after density changes too: a selected player's stat row may now
// share its width with bases or use a different label and font size.
export function fitPlayerTagBreakdowns(root = document) {
    root.querySelectorAll(".detail-tags-by-colour").forEach((breakdown) => {
        const tags = breakdown.closest(".detail-tags");
        const line = breakdown.closest(".detail-tags-line");
        const tile = breakdown.closest(".player-summary");
        if (!tags || !line || !tile) return;
        tile.classList.remove("tag-breakdown-hide-team-kills", "tag-breakdown-hide-bases");
        const overflows = () => {
            const bounds = line.getBoundingClientRect();
            return line.scrollWidth > line.clientWidth + 1 ||
                tags.scrollWidth > tags.clientWidth + 1 ||
                [...breakdown.children].some((opponent) => {
                    const rect = opponent.getBoundingClientRect();
                    return rect.width && (rect.left < bounds.left - 0.5 ||
                        rect.right > bounds.right + 0.5);
                });
        };
        if (!overflows()) return;
        tile.classList.add("tag-breakdown-hide-team-kills");
        if (overflows()) tile.classList.add("tag-breakdown-hide-bases");
    });
}

// Fit only the hit count inside the base border. The separate destroy badge
// and the player card's other text keep their own size and position.
export function fitBaseHitCounts(root = document) {
    const counts = [...root.querySelectorAll(".base-box > .base-hit-count")];
    counts.forEach((count) => count.style.removeProperty("--base-hit-scale"));
    const scales = counts.map((count) => {
        if (!count.textContent.trim()) return 1;
        const box = count.parentElement;
        const bounds = box.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return 1;
        const style = getComputedStyle(box);
        const zoom = box.offsetWidth ? bounds.width / box.offsetWidth : 1;
        const width = (box.clientWidth - parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight)) * zoom;
        const height = (box.clientHeight - parseFloat(style.paddingTop) -
            parseFloat(style.paddingBottom)) * zoom;
        const range = document.createRange();
        range.selectNodeContents(count);
        const text = range.getBoundingClientRect();
        if (!text.width || !text.height) return 1;
        return Math.max(0.01, Math.min(1,
            (width - zoom) / text.width,
            (height - zoom) / text.height));
    });
    counts.forEach((count, index) => {
        if (scales[index] < 1) {
            count.style.setProperty("--base-hit-scale", String(scales[index]));
        }
    });
}

// A docked card can be small on any screen. Keep its content layout tied to
// its own box, independent of the viewport and the game's grouping strategy.
function setPlayerDensity(tile) {
    const width = tile.clientWidth;
    const height = tile.clientHeight;
    // Landscape cards can fit the complete two-column detail set before they
    // are tall enough for the normal stacked full-card header.
    const wideShallowFull = width >= 240 && height >= 84 && height < 112;
    tile.classList.remove("player-tile-short", "player-tile-narrow", "player-tile-minimal");
    if ((width >= 160 && height >= 112) || wideShallowFull) {
        if (width >= 320 || wideShallowFull) tile.dataset.playerLayout = "wide";
        else delete tile.dataset.playerLayout;
        delete tile.dataset.playerDensity;
        if (wideShallowFull) tile.dataset.playerHeader = "inline";
        else delete tile.dataset.playerHeader;
        delete tile.dataset.playerPrimary;
        delete tile.dataset.playerStats;
        delete tile.dataset.playerSummary;
        return;
    }
    const wideCompact = width >= 240 && height >= 66;
    if (wideCompact) tile.dataset.playerLayout = "wide-compact";
    else delete tile.dataset.playerLayout;
    const inline = width >= 120 || height < 34;
    const stackedStats = width < 120;
    // A mid-width card can still use a prominent centred header. Wider cards
    // spend that same height on an inline header and additional stats.
    const centeredHeader = width >= 160 && width < 240 && height >= 86;
    const detailed = width >= 160 ? false : width >= 120 ? height >= 94 : height >= 148;
    const density = detailed ? "detailed" : inline
        ? height < 34 ? "summary" : height < 48 ? "strip" : height < 66 ? "brief" : "compact"
        : height < 78 ? "summary" : height < 94 ? "brief" : "compact";
    for (const [key, value] of Object.entries({
        playerHeader: centeredHeader ? "centered" : inline ? "inline" : "stacked",
        playerPrimary: width >= 160 && height >= 54 ? "large" : "small",
        playerStats: stackedStats ? "stacked" : width < 160 ? "tight" : "paired",
        playerDensity: density,
    })) {
        if (tile.dataset[key] !== value) tile.dataset[key] = value;
    }
    if (density === "summary" && width >= 160) tile.dataset.playerSummary = "details";
    else delete tile.dataset.playerSummary;
}

function measureContentScale(tile) {
    const style = getComputedStyle(tile);
    const available = tile.clientHeight - parseFloat(style.paddingTop) -
        parseFloat(style.paddingBottom);
    const availableWidth = tile.clientWidth - parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
    const contents = [...tile.querySelectorAll(CONTENT_SELECTOR)]
        .filter((element) => getComputedStyle(element).display !== "none");
    if (!contents.length) return 1;
    // Bounds include the viewer's tile zoom; clientHeight is in unscaled
    // CSS pixels. Compare in the same coordinate system before fitting.
    const zoom = tile.offsetHeight ? tile.getBoundingClientRect().height / tile.offsetHeight : 1;
    // Detail grids can have descendants taller than their own clipped box.
    // Include those bounds so fitting preserves every visible stat line.
    const rects = contents.flatMap((element) => [element, ...element.querySelectorAll("*")])
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.height && rect.width);
    if (!rects.length) return 1;
    const height = (Math.max(...rects.map((rect) => rect.bottom)) -
        Math.min(...rects.map((rect) => rect.top))) / (zoom || 1);
    const isTeam = tile.matches("li");
    const widths = contents.map((element) => {
        if (!isTeam) return element.scrollWidth;
        // Right-aligned scores can overflow to the left without increasing
        // scrollWidth. Measure the text itself as well as its layout box.
        const range = document.createRange();
        range.selectNodeContents(element);
        return Math.max(element.scrollWidth, range.getBoundingClientRect().width / (zoom || 1));
    });
    const width = isTeam && style.flexDirection === "row"
        ? widths.reduce((total, value) => total + value, 0) +
            (parseFloat(style.columnGap) || 0) * (contents.length - 1)
        : Math.max(...widths);
    return Math.min(
        1,
        height > available ? Math.max(0, available - 1) / height : 1,
        width > availableWidth ? Math.max(0, availableWidth - 1) / width : 1,
    );
}

// Fit the text and stats, not the card border: the grid remains the authority
// for card geometry, including when the divider leaves very little room.
export function fitTileContents() {
    if (!document.body.classList.contains("game-view-active")) return;
    const tiles = [...document.querySelectorAll(TILE_SELECTOR)];
    tiles.filter((tile) => tile.matches(".player-summary")).forEach(setPlayerDensity);
    // Team density follows its own row, not the neighbouring player cards.
    // Drop secondary stats before fitting the name and score into a short row.
    tiles.filter((tile) => tile.matches("li")).forEach((tile) => {
        tile.classList.toggle("team-tile-compact", tile.clientHeight < 100);
        tile.classList.toggle("team-tile-minimal", tile.clientHeight < 64);
        tile.classList.toggle("team-tile-inline", tile.clientHeight < 32 ||
            (tile.clientWidth >= 180 && tile.clientHeight < 100));
    });
    tiles.forEach((tile) => {
        tile.style.removeProperty("--tile-content-scale");
        tile.style.removeProperty("--team-score-width-scale");
    });
    fitPlayerTagBreakdowns();
    tiles.filter((tile) => tile.matches("li:not(.team-tile-inline)")).forEach((tile) => {
        const score = tile.querySelector(".team-score");
        if (!score) return;
        const style = getComputedStyle(tile);
        const availableWidth = tile.clientWidth - parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight);
        const zoom = tile.offsetWidth ? tile.getBoundingClientRect().width / tile.offsetWidth : 1;
        const range = document.createRange();
        range.selectNodeContents(score);
        const scoreWidth = range.getBoundingClientRect().width / (zoom || 1);
        if (scoreWidth > availableWidth) {
            // A wide score must not also shrink a name that already wraps
            // comfortably inside its own row.
            tile.style.setProperty("--team-score-width-scale",
                String(Math.max(0.01, (availableWidth - 1) / scoreWidth)));
        }
    });
    const scales = tiles.map((tile) => {
        // Small cards shed secondary rows instead of shrinking every label
        // and base number into an unreadable miniature of a desktop card.
        if (tile.dataset.playerDensity) return 1;
        let scale = measureContentScale(tile);
        if (tile.matches("li")) {
            // Preserve the name and score before shrinking them to make room
            // for secondary tags. Resetting density above keeps this stable
            // when the pane grows or the displayed scores change.
            for (const density of ["team-tile-compact", "team-tile-minimal"]) {
                if (scale >= 1) break;
                tile.classList.add(density);
                scale = measureContentScale(tile);
            }
        }
        return scale;
    });
    tiles.forEach((tile, index) => {
        if (scales[index] < 1) {
            tile.style.setProperty("--tile-content-scale", String(Math.max(0.01, scales[index])));
        }
    });
    fitBaseHitCounts();
}

export function observeTileSizes(onResize) {
    stopObservingTileSizes();
    if (typeof ResizeObserver === "undefined" ||
        !document.body.classList.contains("game-view-active")) return;
    resizeObserver = new ResizeObserver(() => {
        // Stop any score-order animation whose origin belongs to the old pane.
        document.querySelectorAll(TILE_SELECTOR).forEach((tile) => {
            if (tile.style.transition.includes("transform")) {
                tile.style.transition = "";
                tile.style.transform = "";
            }
        });
        onResize();
    });
    document.querySelectorAll(TILE_SELECTOR).forEach((tile) => resizeObserver.observe(tile));
}

export function stopObservingTileSizes() {
    resizeObserver?.disconnect();
    resizeObserver = null;
}
