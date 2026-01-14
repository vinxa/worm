// playerTiles.js
import { formatGameDatetime, computePlayerStats, computeBaseStats, computeTeamTotal, computeHeadToHeadTags } from "./utils.js";
import { showGame } from "./ui.js";
import { state } from "./state.js";
import { updatePlayerSeriesDisplay, toggleTeamVisibility } from "./timeline.js";

const FAST_SORT_MIN_INTERVAL = 2; // seconds of game time
let lastTileSortGameTime = -Infinity;

export function updatePlayerTiles(currentTime) {
    const focusPid =
        state.selectedPlayers && state.selectedPlayers.size === 1
        ? Array.from(state.selectedPlayers)[0]
        : null;
    const focusName = focusPid ? state.gameData.players[focusPid]?.name || "Player" : "";

    document.querySelectorAll(".player-summary").forEach((tile) => {
        const pid = tile.dataset.playerId;
        const events = state.playerEvents[pid] || [];
        let score = 0;
        for (let ev of events) {
        if (ev.time <= currentTime) {
            // sum the playerDelta (fallback to ev.delta if needed)
            score += ev.playerDelta ?? ev.delta ?? 0;
        } else {
            break;
        }
        }
        // update the tile
        const scoreEl = tile.querySelector(".player-score");
        if (scoreEl) scoreEl.textContent = score;
        tile.classList.toggle("_negative", score < 0);

        const { tagsFor, tagsAgainst, ratioText, baseCount, deniesCount } =
        computePlayerStats(pid, currentTime);

        const tagsEl = tile.querySelector(".detail-tags");
        const tagsLabelEl = tile.querySelector(".detail-tags-label");
        const ratioEl = tile.querySelector(".detail-ratio");
        const deniesEl = tile.querySelector(".detail-denies");

        if (tagsEl) {
        if (focusPid && focusPid !== pid) {
            const headToHead = computeHeadToHeadTags(focusPid, pid, currentTime);
            tagsEl.innerHTML =
            `${tagsFor} – ${tagsAgainst} ` +
            `<span class="detail-tags-h2h">(${headToHead.tagsFor} – ${headToHead.tagsAgainst})</span>`; // using thin spaces
            if (tagsLabelEl) tagsLabelEl.textContent = "Tags:";
        } else {
            tagsEl.textContent = `${tagsFor} – ${tagsAgainst}`; // using thin spaces
            if (tagsLabelEl) tagsLabelEl.textContent = "Tags:";
        }
        }
        if (ratioEl) ratioEl.textContent = ratioText;
        if (deniesEl) deniesEl.textContent = deniesCount;
        const myTeamId = state.gameData.players[pid].team; // e.g. "green"
        const opponents = state.gameData.teams
        .filter((t) => t.id !== myTeamId) // keep only other teams
        .map((t) => ({ id: t.id, color: t.color })); // get their IDs & colors
        const baseStats = computeBaseStats(pid, currentTime);
        const container = tile.querySelector(".detail-bases");

        if (container) {
        container.innerHTML = opponents
            .map(({ id, color }) => {
            // stat for this target:
            const stat = baseStats[id] || { count: 0, destroyed: false };
            return `
        <div class="base-box${stat.destroyed ? " filled" : ""}"
            style="
                border-color: ${color};
                ${stat.destroyed ? `background:${color}` : ""}
            ">
            ${stat.count}
        </div>
        `;
            })
            .join("");
        }
    });

    const fastRate = state.playbackRate && state.playbackRate > 1.25;
    const shouldSort =
        !fastRate || currentTime - lastTileSortGameTime >= FAST_SORT_MIN_INTERVAL;
    if (shouldSort) {
        const durationMs = fastRate ? 120 : 300;
        sortTiles(durationMs);
        lastTileSortGameTime = currentTime;
    }
}

export function generatePlayerTiles() {
    const grid = document.getElementById("playerGrid");
    grid.innerHTML = "";
    lastTileSortGameTime = -Infinity;
    const ids = Object.keys(state.gameData.playerStats).slice(0, 15);

    ids.forEach((pid) => {
        const stats = state.gameData.playerStats[pid] || {};
        const tile = document.createElement("div");
        tile.classList.add("player-summary");
        tile.classList.add("expanded");
        tile.dataset.playerId = pid;
        tile.innerHTML = `
        <div class="player-summary-header">
            <div class="player-name">${stats.name || "–"}</div>
            <div class="player-score">${stats.score ?? "0"}</div>
        </div>
        <div class="player-summary-details">
            <p class="detail-tags-line"><span class="detail-tags-label">Tags:</span> <span class="detail-tags">–</span></p>
            <p class="detail-ratio-line">TR: <span class="detail-ratio">–</span></p>
            <div class="detail-bases"></div>
            <p class="detail-denies-line">Denies: <span class="detail-denies">–</span></p>
        </div>
        `;

        grid.appendChild(tile);
        updatePlayerTiles(tile);
    });
}

export function colourPlayerNamesFromChart() {
    document.querySelectorAll(".player-summary").forEach((tile) => {
        const pid = tile.dataset.playerId;
        const player = state.gameData.players[pid];
        if (!player) return;

        // 1) find that player’s team
        const teamId = player.team; // e.g. 1, 2, 3

        // 2) grab the live-series for that team
        const liveSeries = state.chart.get(teamId + "-live");

        if (liveSeries) {
        // 3) paint the name in the exact same color
        tile.querySelector(".player-name").style.color = liveSeries.color;
        }
    });
}

export function setupTeamSeriesFilter() {
    const items = document.querySelectorAll(".team-scores li");
    items.forEach((el) => el.classList.remove("active-team-filter"));
    items.forEach((li) => {
        li.style.cursor = "pointer";
        li.addEventListener("click", () => {
        const teamId = li.dataset.teamId;
        if (!teamId) return;
        toggleTeamVisibility(teamId);
        const activeSet = state.hiddenTeams || new Set();
        items.forEach((el) => {
            const inactive = activeSet.has(el.dataset.teamId);
            el.classList.toggle("inactive-team-filter", inactive);
        });
        });
    });
}

// Expand‐in‐place logic for each tile
export function setupTileExpansion() {
    document.querySelectorAll(".player-summary").forEach((tile) => {
        tile.addEventListener("click", (e) => {
        const clickedTile = e.currentTarget;
        const pid = clickedTile.dataset.playerId;

        // toggle graph view
        const isSelected = clickedTile.classList.toggle("selected");
        if (!isSelected) return; // collapse: nothing to fill */
        });
    });
} 

/**
 * Write the current teamScores into the HTML.
 */
export function updateTeamScoresUI() {
    if (!state.chart) return;

    Object.entries(state.teamScores).forEach(([teamId, score]) => {
        const li = document.querySelector(
        `.team-scores li[data-team-id="${teamId}"]`
        );
        const name = li?.querySelector(".team-name");
        const span = li?.querySelector(".team-score");
        if (!name || !span) return;

        // update the score text
        span.textContent = score;

        // pull the chart’s live-series color
        if (state.chart) {
            const series = state.chart.get(teamId + "-live");
            const color = series ? series.color : "";

            // color the team-name, leave the score in default color
            name.style.color = color;
        }
    });

    sortTeamScoresUI();
}

/**
 * Reorders all .player-summary tiles in #playerGrid
 * by their current .player-score (desc).
 */
function sortTiles(transitionMs = 300) {
    const grid = document.getElementById("playerGrid");
    const tiles = Array.from(grid.children);

    // 1) Record old positions (FLIP pre‐step)
    const oldRects = new Map();
    tiles.forEach((tile) => {
        oldRects.set(tile, tile.getBoundingClientRect());
        tile.style.transition = "";
        tile.style.transform = "";
    });

    // 2) Compute *current* team scores if you don't have them already
    //    (e.g. from updateTeamScoresForTime or similar)
    const totals = {};
    state.gameData.teams.forEach((team) => {
        totals[team.id] = computeTeamTotal(team.id, state.currentTime);
    });
    // --------------------------------------------
    // You need a `computeTeamTotal(teamId, t)` that returns
    // the sum of all ev.delta for that team up to `t`.
    // --------------------------------------------

    // 3) Build an array of team IDs sorted by descending total
    const sortedTeamIds = state.gameData.teams
        .map((t) => t.id)
        .sort((a, b) => (totals[b] || 0) - (totals[a] || 0));

    // 4) Group tiles by team
    const byTeam = {};
    tiles.forEach((tile) => {
        const pid = tile.dataset.playerId;
        const teamId = state.gameData.players[pid].team;
        (byTeam[teamId] ||= []).push(tile);
    });

    // 5) Within each team, sort players by descending score
    sortedTeamIds.forEach((teamId) => {
        const arr = byTeam[teamId] || [];
        arr.sort((a, b) => {
        const sa = +a.querySelector(".player-score").textContent;
        const sb = +b.querySelector(".player-score").textContent;
        return sb - sa;
        });
    });

    // 6) Re‐append in row order = sortedTeamIds
    sortedTeamIds.forEach((teamId) => {
        (byTeam[teamId] || []).forEach((tile) => {
        grid.appendChild(tile);
        });
    });

    // 7) FLIP animate from oldRects → new positions
    tiles.forEach((tile) => {
        const oldRect = oldRects.get(tile);
        const newRect = tile.getBoundingClientRect();
        const dx = oldRect.left - newRect.left;
        const dy = oldRect.top - newRect.top;
        if (!dx && !dy) return;

        tile.style.transform = `translate(${dx}px,${dy}px)`;
        tile.getBoundingClientRect(); // force reflow
        tile.style.transition = `transform ${transitionMs}ms ease`;
        tile.style.transform = "";
        tile.addEventListener("transitionend", function handler() {
        tile.style.transition = "";
        tile.removeEventListener("transitionend", handler);
        });
    });
}

/**
 * Re-orders the .team-scores <li>s by descending team score,
 * and animates the move via FLIP.
 */
function sortTeamScoresUI() {
    const ul = document.querySelector(".team-scores");
    const items = Array.from(ul.children);

    // 1) Record old positions
    const oldRects = new Map();
    items.forEach((li) => {
        oldRects.set(li, li.getBoundingClientRect());
        li.style.transition = "";
        li.style.transform = "";
    });

    // 2) Compute current team totals
    const totals = {};
    state.gameData.teams.forEach((team) => {
        totals[team.id] = computeTeamTotal(team.id, state.currentTime);
    });

    // 3) Sort team IDs by descending total
    const sortedIds = state.gameData.teams
        .map((t) => t.id)
        .sort((a, b) => (totals[b] || 0) - (totals[a] || 0));

    // 4) Build new order of <li> elements
    const newOrder = sortedIds
        .map((id) => ul.querySelector(`li[data-team-id="${id}"]`))
        .filter(Boolean);

    // 5) Re-append in sorted order
    newOrder.forEach((li) => ul.appendChild(li));

    // 6) FLIP animate from old → new
    newOrder.forEach((li) => {
        const oldRect = oldRects.get(li);
        const newRect = li.getBoundingClientRect();
        const dx = oldRect.left - newRect.left;
        const dy = oldRect.top - newRect.top;
        if (!dx && !dy) return;

        // invert
        li.style.transform = `translate(${dx}px,${dy}px)`;
        // force reflow
        li.getBoundingClientRect();
        // play
        li.style.transition = "transform 300ms ease";
        li.style.transform = "";
        // cleanup
        li.addEventListener("transitionend", function handler() {
        li.style.transition = "";
        li.removeEventListener("transitionend", handler);
        });
    });
}


export function setupPlayerSeriesToggles() {
    document.querySelectorAll(".player-summary").forEach((tile) => {
        tile.addEventListener("click", (e) => {
            const clickedTile = e.currentTarget;
            const pid = clickedTile.dataset.playerId;
            if ( state.isGameLoading || !state.gameData || !state.gameData.players || !state.gameData.players[pid] ) return; // ignore clicks while loading

            // toggle in the Set
            if (state.selectedPlayers.has(pid)) {
                state.selectedPlayers.delete(pid);
            } else {
                state.selectedPlayers.add(pid);
            }

            // sync chart to only show selected players
            updatePlayerSeriesDisplay();
            updatePlayerTiles(state.currentTime);

            // if we just expanded, pull the series color and set the border
            const isSelected = clickedTile.classList.contains("selected");
            if (isSelected) {
                const s = state.chart.get(pid + "-player");
                const c = s ? s.color : "#e2b12a";
                clickedTile.style.borderColor = c;
            } else {
                // collapsed — reset to default
                clickedTile.style.borderColor = "";
            }
        });
    });
}
