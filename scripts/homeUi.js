import { state } from "./state.js";
import { formatGameDatetime } from "./utils.js";
import { applyFilter, populateFilterOptions } from "./gameFilters.js";
import { getEventTeamColourMap, getGameDisplayTitle, getMatchedEventTeamNames } from "./displayLabels.js";
import { wiggleLogos } from "./wormThings.js";

const gameHeader = document.querySelector("body > .app-header");
const gameSections = [
    document.querySelector(".top-section"),
    document.querySelector(".timeline-section"),
];
const homeView = document.getElementById("home-view");
const leftBtn = document.querySelector(".nav-button.left");

function setGridTitleContent(titleEl, game, displayTitle) {
    const matchedTeams = getMatchedEventTeamNames(game, state.events || []);
    const teamColourMap = getEventTeamColourMap(game, state.events || []);
    if (!matchedTeams.length) {
        titleEl.textContent = displayTitle;
        return;
    }

    const prefixText = displayTitle.includes(":")
        ? `${displayTitle.split(":")[0]}: `
        : "";

    titleEl.textContent = "";
    const prefix = document.createElement("span");
    prefix.textContent = prefixText;
    titleEl.appendChild(prefix);

    matchedTeams.forEach((teamName, idx) => {
        const teamSpan = document.createElement("div");
        teamSpan.className = `game-title-team game-title-team--${idx % 3}`;
        const trimmed = String(teamName || "").trim();
        const shortName = trimmed.length > 20 ? `${trimmed.slice(0, 20)}...` : trimmed;
        teamSpan.textContent = shortName;
        if (teamColourMap[teamName]) {
            teamSpan.style.color = teamColourMap[teamName];
        }
        if (shortName !== trimmed) {
            teamSpan.title = trimmed;
        }
        titleEl.appendChild(teamSpan);
    });
}

function fitDisplayTitleToTile(titleEl, enabled) {
    titleEl.style.fontSize = "";
    if (!enabled) return;

    requestAnimationFrame(() => {
        let sizePx = 12.5;
        const minSizePx = 6;
        const stepPx = 0.5;
        titleEl.style.fontSize = `${sizePx}px`;

        let guard = 0;
        while (titleEl.scrollHeight > titleEl.clientHeight + 0.5 && sizePx > minSizePx && guard < 30) {
            sizePx -= stepPx;
            titleEl.style.fontSize = `${sizePx}px`;
            guard += 1;
        }
    });
}

export function createHomeUi({ showGame, updateNextGameButtonVisibility }) {
    function buildGrid(games, highlightIds = []) {
        const grid = document.getElementById("gamesGrid");
        grid.innerHTML = ""; // clear any old tiles
        const highlightSet = new Set(highlightIds);
        populateFilterOptions(games);
        const filtered = applyFilter(games);

        filtered.forEach((game) => {
            const tile = document.createElement("div");
            tile.classList.add("game-tile");
            const originalTitle = game?.title || "";
            const raw = getGameDisplayTitle(game, state.events || []);
            const isDisplayTitle = raw !== originalTitle;

            const gameLine = document.createElement("span");
            gameLine.textContent = formatGameDatetime(game.id);

            const rawLine = document.createElement("span");
            rawLine.classList.add("game-title-text");
            if (isDisplayTitle) rawLine.classList.add("game-title-text--display");
            setGridTitleContent(rawLine, game, raw);

            tile.appendChild(gameLine);
            tile.appendChild(rawLine);
            fitDisplayTitleToTile(rawLine, isDisplayTitle);
            tile.addEventListener("click", () => {
                if (typeof showGame === "function") showGame(game);
            });
            grid.appendChild(tile);

            if (highlightSet.has(game.id)) {
                tile.classList.add("flash-new");
                setTimeout(() => tile.classList.remove("flash-new"), 3000);
            }
        });
    }

    function showHome() {
        homeView.style.display = "block";
        leftBtn.style.display = "none";
        gameHeader.style.display = "none";
        gameSections.forEach((s) => (s.style.display = "none"));
        state.selectedPlayers = new Set();
        if (typeof updateNextGameButtonVisibility === "function") {
            updateNextGameButtonVisibility(false, false);
        }
        wiggleLogos();
    }

    return { buildGrid, showHome };
}
