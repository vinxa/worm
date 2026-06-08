// playerTiles.js
import { computePlayerStats, computeBaseStats, computeTeamTotal, computeHeadToHeadTags, computePlayerUptime, getPlayerHighlightColor } from "./utils.js";
import { state } from "./state.js";
import { updatePlayerSeriesDisplay, toggleTeamVisibility } from "./timeline.js";

const FAST_SORT_MIN_INTERVAL = 2; // seconds of game time
let lastTileSortGameTime = -Infinity;
const BASE_HIT_FLASH_MS = 500;
const BASE_DESTROY_FLASH_MS = BASE_HIT_FLASH_MS * 2;
const BASE_TEXT_CONTRAST_THRESHOLD = 186;
const baseHitFlashTimeouts = new Map();
let lastTileUpdateTime = -Infinity;

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    return result
        ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16),
        }
        : null;
}

function getContrastTextColor(hexColor, threshold = BASE_TEXT_CONTRAST_THRESHOLD) {
    const rgb = hexToRgb(hexColor);
    if (!rgb) return "#ffffff";
    return rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114 > threshold
        ? "#000000"
        : "#ffffff";
}

function resetBaseHitFlashState() {
    baseHitFlashTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
    baseHitFlashTimeouts.clear();
    lastTileUpdateTime = -Infinity;
    document.querySelectorAll(".player-summary.flash-base-hit").forEach((tile) => {
        tile.classList.remove("flash-base-hit");
        tile.style.removeProperty("--flash-color");
        tile.style.removeProperty("--flash-duration");
    });
}

function flashPlayerTile(pid, tile, color, durationMs, className) {
    tile.style.setProperty("--flash-color", color);
    const rate = state.playbackRate || 1;
    const flashDuration = Math.max(90, durationMs / rate);
    tile.style.setProperty("--flash-duration", `${flashDuration}ms`);
    tile.classList.add(className);
    const existing = baseHitFlashTimeouts.get(pid);
    if (existing) clearTimeout(existing);
    const timeoutId = setTimeout(() => {
        tile.classList.remove(className);
        tile.style.removeProperty("--flash-color");
        tile.style.removeProperty("--flash-duration");
        baseHitFlashTimeouts.delete(pid);
    }, flashDuration);
    baseHitFlashTimeouts.set(pid, timeoutId);
}

export function updatePlayerTiles(currentTime) {
    if (!state.isPlaying) {
        resetBaseHitFlashState();
    }
    const timeJump =
        lastTileUpdateTime !== -Infinity &&
        Math.abs(currentTime - lastTileUpdateTime) > 1.5;
    const flashWindowStart =
        lastTileUpdateTime === -Infinity || !state.isPlaying || timeJump
            ? currentTime
            : lastTileUpdateTime;
    const focusPid =
        state.selectedPlayers && state.selectedPlayers.size === 1
        ? Array.from(state.selectedPlayers)[0]
        : null;
    const focusName = focusPid ? state.gameData.players[focusPid]?.name || "Player" : "";

    document.querySelectorAll(".player-summary").forEach((tile) => {
        const pid = tile.dataset.playerId;
        const events = state.playerEvents[pid] || [];
        let score = 0;
        let isActive = true;
        let latestBaseEvent = null;
        for (let ev of events) {
        if (ev.time <= currentTime) {
            // sum the playerDelta (fallback to ev.delta if needed)
            score += ev.playerDelta ?? ev.delta ?? 0;
            if (ev.type === "deactivated") isActive = false;
            if (ev.type === "reactivated") isActive = true;
            if (ev.type === "base hit" || ev.type === "base destroy") {
                if (
                    !latestBaseEvent ||
                    ev.time > latestBaseEvent.time ||
                    (ev.time === latestBaseEvent.time &&
                        ev.type === "base destroy" &&
                        latestBaseEvent.type !== "base destroy")
                ) {
                    latestBaseEvent = ev;
                }
            }
        } else {
            break;
        }
        }
        // update the tile
        const scoreEl = tile.querySelector(".player-score");
        if (scoreEl) scoreEl.textContent = score;
        tile.classList.toggle("_negative", score < 0);
        tile.classList.toggle("is-deactivated", !isActive);

        const { tagsFor, tagsAgainst, ratioText, baseCount, deniesCount, teamKillsFor, teamKillsAgainst } =
        computePlayerStats(pid, currentTime);

        const tagsEl = tile.querySelector(".detail-tags");
        const tagsLabelEl = tile.querySelector(".detail-tags-label");
        const ratioEl = tile.querySelector(".detail-ratio");
        const deniesEl = tile.querySelector(".detail-denies");
        const uptimeEl = tile.querySelector(".detail-uptime");

        if (tagsEl) {
        if (focusPid && focusPid !== pid) {
            // Show head to head stats for other players if we have a focused player.
            const headToHead = computeHeadToHeadTags(focusPid, pid, currentTime);
            tagsEl.innerHTML =
            `${tagsFor} – ${tagsAgainst} ` +
            `<span class="detail-tags-h2h">(${headToHead.tagsFor} – ${headToHead.tagsAgainst})</span>`; // using thin spaces
            if (tagsLabelEl) tagsLabelEl.textContent = "Tags:";
        } else {
            tagsEl.innerHTML =
            `${tagsFor} – ${tagsAgainst} ` +
            `<span class="detail-tags-teamKills">(${teamKillsFor} – ${teamKillsAgainst})</span>`;
            //tagsEl.textContent = `${tagsFor} – ${tagsAgainst}`; // using thin spaces
        }
        }
        if (ratioEl) ratioEl.textContent = ratioText;
        if (deniesEl) deniesEl.textContent = deniesCount;
        if (uptimeEl) {
        const uptime = computePlayerUptime(pid, currentTime);
        const pct = Math.round(uptime * 100);
        uptimeEl.textContent = `${pct}%`;
        }
        const myTeamId = (state.gameData.players[pid]?.team || "").toLowerCase();
        const baseStats = computeBaseStats(pid, currentTime);
        const teamColorById = Object.fromEntries(
            state.gameData.teams.map((t) => [t.id, t.color])
        );
        const activeBases = (state.gameData.active_bases || []).filter(
            (base) => base && base.id && base.id.toLowerCase() !== myTeamId
        );
        const container = tile.querySelector(".detail-bases");

        if (container) {
        container.innerHTML = activeBases
            .map(({ id, color }) => {
            const baseColor = color || teamColorById[id] || id;
            // stat for this target:
            const stat = baseStats[id] || { count: 0, destroyed: false };
            const textColor = getContrastTextColor(baseColor);
            return `
        <div class="base-box${stat.destroyed ? " filled" : ""}"
            style="
                border-color: ${baseColor};
                ${stat.destroyed ? `background:${baseColor}; color:${textColor};` : ""}
            ">
            ${stat.count}
        </div>
        `;
            })
            .join("");
        }

        if (state.isPlaying && latestBaseEvent && latestBaseEvent.time > flashWindowStart) {
            const baseTeamId = (latestBaseEvent.target || "").toLowerCase();
            const baseColor =
                teamColorById[baseTeamId] ||
                activeBases.find((b) => b.id && b.id.toLowerCase() === baseTeamId)?.color ||
                "#e2b12a";
            const durationMs =
                latestBaseEvent.type === "base destroy"
                    ? BASE_DESTROY_FLASH_MS
                    : BASE_HIT_FLASH_MS;
            const className =
                latestBaseEvent.type === "base destroy"
                    ? "flash-base-destroy"
                    : "flash-base-hit";
            flashPlayerTile(pid, tile, baseColor, durationMs, className);
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
    lastTileUpdateTime = currentTime;
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
            <div class="detail-left">
                <p class="detail-tags-line"><span class="detail-tags-label">Tags:</span> <span class="detail-tags">–</span></p>
                <div class="detail-bases"></div>
            </div>
            <div class="detail-right">
                <p class="detail-ratio-line">TR: <span class="detail-ratio">–</span></p>
                <p class="detail-denies-line">Denies: <span class="detail-denies">–</span></p>
                <p class="detail-uptime-line">Uptime: <span class="detail-uptime">–</span></p>
            </div>
        </div>
        `;

        // player name is team colour
        const player = state.gameData.players[pid];
        if (player) {
            const team = state.gameData.teams.find(t => t.id === player.team);
            const color = team ? team.color : "";
            tile.querySelector(".player-name").style.color = color;
        }

        grid.appendChild(tile);
        updatePlayerTiles(state.currentTime);
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

        // pull team color from game data
        const team = state.gameData.teams.find(t => t.id === teamId);
        const color = team ? team.color : "";

        // color the team-name, leave the score in default color
        name.style.color = color;
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

    // 6) Layout: use the larger dimension as columns
    const teamCount = sortedTeamIds.length;
    const maxTeamSize = Math.max(
        1,
        ...sortedTeamIds.map((teamId) => (byTeam[teamId] || []).length)
    );

    if (teamCount >= maxTeamSize) {
        // Teams as columns (more teams than players per team)
        grid.style.gridTemplateColumns = `repeat(${teamCount}, minmax(0, 1fr))`;
        grid.style.gridTemplateRows = `repeat(${maxTeamSize}, auto)`;
        sortedTeamIds.forEach((teamId, colIdx) => {
        const arr = byTeam[teamId] || [];
        arr.forEach((tile, rowIdx) => {
            tile.style.gridColumn = colIdx + 1;
            tile.style.gridRow = rowIdx + 1;
        });
        });
    } else {
        // Teams as rows (more players per team than teams)
        grid.style.gridTemplateColumns = `repeat(${maxTeamSize}, minmax(0, 1fr))`;
        grid.style.gridTemplateRows = `repeat(${teamCount}, auto)`;
        sortedTeamIds.forEach((teamId, rowIdx) => {
        const arr = byTeam[teamId] || [];
        arr.forEach((tile, colIdx) => {
            tile.style.gridRow = rowIdx + 1;
            tile.style.gridColumn = colIdx + 1;
        });
        });
    }

    // 7) Re‐append in row order = sortedTeamIds
    sortedTeamIds.forEach((teamId) => {
        (byTeam[teamId] || []).forEach((tile) => {
        grid.appendChild(tile);
        });
    });

    // 8) FLIP animate from oldRects → new positions
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
            clickedTile.classList.toggle("selected");

            // if selected, set the border to the highlight color
            const isSelected = clickedTile.classList.contains("selected");
            if (isSelected) {
                clickedTile.style.borderColor = getPlayerHighlightColor(pid);
            } else {
                // collapsed — reset to default
                clickedTile.style.borderColor = "";
            }
        });
    });
}
