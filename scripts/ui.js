// ui.js

import { state } from "./state.js";
import { seekToTime, handleSkip, setPlaybackRate, stepPlaybackRate, togglePlayback, jumpToStart, jumpToEnd, goToLatestGame } from "./replayHandler.js";
import { wiggleLogos, setupLogoDance } from "./wormThings.js";
import { loadGameData } from "./main.js";
import { formatGameDatetime, getGameDuration } from "./utils.js";
import { applyFilter, populateFilterOptions } from "./gameFilters.js";
import { setupKeyboardControls } from "./keyboard.js";
import { initLiveChart, buildTeamTimeline, buildPlayerTimelines } from "./timeline.js";
import { generatePlayerTiles, setupTileExpansion, setupPlayerSeriesToggles, colourPlayerNamesFromChart, setupTeamSeriesFilter } from "./playerTiles.js";
import { setupDraggableModal } from "./video.js";
import { getEventTeamColourMap, getGameDisplayTitle, getMatchedEventTeamNames, getTeamLabelMapForGame } from "./displayLabels.js";

// Shared UI elements
const gameHeader = document.querySelector("body > .app-header");
const gameSections = [
    document.querySelector(".top-section"),
    document.querySelector(".timeline-section"),
];
const homeView = document.getElementById("home-view");
const leftBtn = document.querySelector(".nav-button.left");
const nextGameBtn = document.querySelector(".next-game-button");
const headerPlayButton = document.getElementById("headerPlayButton");
const headerSpeedButton = document.getElementById("headerSpeedButton");
const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 4];

function applySpeedLabel() {
    const label = `${state.playbackRate}x`;
    const speedButton = document.getElementById("speedButton");
    if (speedButton) speedButton.textContent = label;
    if (headerSpeedButton) headerSpeedButton.textContent = label;
}

function stepPlaybackRateUi(direction) {
    stepPlaybackRate(direction, { speeds: SPEED_OPTIONS });
    applySpeedLabel();
}

function loadGameAtIndex(idx) {
    const games = state.games || [];
    if (idx < 0 || idx >= games.length) return false;
    state.selectedPlayers = new Set();
    showGame(games[idx]);
    return true;
}

export function updateNextGameButtonVisibility(fade = false, flash = false) {
    if (!nextGameBtn) return;
    const shouldShow =
        !!state.selectedGame &&
        !!state.latestGame &&
        state.selectedGame.id !== state.latestGame.id;

    if (shouldShow) {
        if (fade) {
            // retrigger transition
            nextGameBtn.classList.remove("is-visible");
            requestAnimationFrame(() => nextGameBtn.classList.add("is-visible"));
        } else {
            nextGameBtn.classList.add("is-visible");
        }
        if (flash) {
            nextGameBtn.classList.add("flash-new");
            setTimeout(() => nextGameBtn.classList.remove("flash-new"), 3000);
        }
    } else {
        nextGameBtn.classList.remove("is-visible");
        nextGameBtn.classList.remove("flash-new");
    }
}

function clickPlayButton() {
    // Hook the Play button to start the replay
    const btn = document.getElementById("playButton");
    const headerBtn = document.getElementById("headerPlayButton");
    const isPlaying = togglePlayback();
    if (isPlaying === null) return;
    if (isPlaying) {
        btn.textContent = "❚❚";
        if (headerBtn) headerBtn.textContent = "❚❚";
        if (state.player && typeof state.player.playVideo === "function") {
            state.player.playVideo();
        }
    } else {
        btn.textContent = "▶";
        if (headerBtn) headerBtn.textContent = "▶";
        if (state.player && typeof state.player.pauseVideo === "function") {
            state.player.pauseVideo();
        }
    }
}

export function showHome() {
    homeView.style.display = "block";
    leftBtn.style.display = "none";
    gameHeader.style.display = "none";
    gameSections.forEach((s) => (s.style.display = "none"));
    state.selectedPlayers = new Set();
    updateNextGameButtonVisibility(false, false);
    wiggleLogos();
}

export function showGame(game) {
    const homeView = document.getElementById("home-view");
    state.selectedGame = game;
    // hide home
    homeView.style.display = "none";
    // show game UI
    leftBtn.style.display = "inline-block";
    gameHeader.style.display = "flex";
    gameSections.forEach((s) => (s.style.display = ""));
    // load existing data
    loadGameData(game.dataPath);
    updateNextGameButtonVisibility(false, false);
    wiggleLogos();
}

function applyCurrentGameTeamLabels() {
    const ul = document.querySelector(".team-scores");
    if (!ul) return;

    const teamLabelMap = getTeamLabelMapForGame(
        state.selectedGame,
        state.gameData?.players || {},
        state.events || []
    );
    const defaultNames = Object.fromEntries(
        (state.gameData?.teams || []).map((t) => [t.id, t.name])
    );
    ul.innerHTML = "";
    (state.gameData?.teams || []).forEach((team) => {
        const li = document.createElement("li");
        li.dataset.teamId = team.id;

        const nameEl = document.createElement("span");
        nameEl.className = "team-name";
        const fullName = teamLabelMap[team.id] || defaultNames[team.id] || team.id;
        const shortName = fullName.length > 8 ? `${fullName.slice(0, 8)}...` : fullName;
        nameEl.textContent = shortName;
        nameEl.title = fullName;

        const score = document.createElement("span");
        score.className = "team-score";
        score.textContent = "0";
        li.appendChild(nameEl);
        li.appendChild(score);
        ul.appendChild(li);
    });
}

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

export function buildGrid(games, highlightIds = []) {
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
        tile.addEventListener("click", () => showGame(game));
        grid.appendChild(tile);

        if (highlightSet.has(game.id)) {
            tile.classList.add("flash-new");
            setTimeout(() => tile.classList.remove("flash-new"), 3000);
        }
    });
}

export function initUI() {
    const leftNavigationButton = document.querySelector(".nav-button.left");
    leftNavigationButton.addEventListener("click", () =>
        showHome(state.selectedGame)
    );

    const gameFilter = document.getElementById("gameFilter");
    const eventFilter = document.getElementById("eventFilter");
    const dateFilter = document.getElementById("dateFilter");
    const playerFilter = document.getElementById("playerFilter");

    const playButton = document.getElementById("playButton");
    playButton.addEventListener("click", clickPlayButton);

    const rewindButton = document.getElementById("rewindButton");
    rewindButton.addEventListener("click", () => handleSkip(-15));

    const forwardButton = document.getElementById("forwardButton");
    forwardButton.addEventListener("click", () => handleSkip(+15));

    if (headerPlayButton) {
        headerPlayButton.addEventListener("click", clickPlayButton);
    }

    const skipStartButton = document.getElementById("skipStartButton");
    if (skipStartButton) skipStartButton.addEventListener("click", () => jumpToStart({ loadGameAtIndex }));

    const skipEndButton = document.getElementById("skipEndButton");
    if (skipEndButton) skipEndButton.addEventListener("click", () => jumpToEnd({ loadGameAtIndex }));

    const speedButton = document.getElementById("speedButton");
    const bindSpeedButton = (btn) => {
        if (!btn) return;
        btn.addEventListener("click", () => {
        const idx = SPEED_OPTIONS.indexOf(state.playbackRate);
        const safeIdx = idx === -1 ? 0 : idx;
        const next = SPEED_OPTIONS[(safeIdx + 1) % SPEED_OPTIONS.length];
        setPlaybackRate(next);
        applySpeedLabel();
        });
    };
    applySpeedLabel();
    bindSpeedButton(speedButton);
    bindSpeedButton(headerSpeedButton);

    if (nextGameBtn) {
        nextGameBtn.addEventListener("click", () => goToLatestGame({ showGame }));
    }

    if (gameFilter) {
        gameFilter.addEventListener("change", (e) => {
            state.gameFilter = e.target.value || "all";
            buildGrid(state.games || []);
        });
    }

    if (eventFilter) {
        eventFilter.addEventListener("change", (e) => {
            state.eventFilter = e.target.value || "none";
            buildGrid(state.games || []);
        });
    }

    if (dateFilter) {
        dateFilter.addEventListener("change", (e) => {
            state.gameDateFilter = e.target.value || "all";
            buildGrid(state.games || []);
        });
    }

    if (playerFilter) {
        const updatePlayerFilter = (value) => {
            const trimmed = (value || "").trim();
            state.gamePlayerFilterText = value || "";
            state.gamePlayerFilter = trimmed === "" ? "all" : trimmed;
            buildGrid(state.games || []);
        };
        playerFilter.addEventListener("change", (e) => updatePlayerFilter(e.target.value));
        playerFilter.addEventListener("input", (e) => updatePlayerFilter(e.target.value));
        playerFilter.addEventListener("focus", (e) => {
            // ensure suggestions are available on focus for Safari/Chrome
            e.target.value = state.gamePlayerFilterText || "";
        });
    }

    setupKeyboardControls({
        onTogglePlay: clickPlayButton,
        onJumpToStart: () => jumpToStart({ loadGameAtIndex }),
        onJumpToEnd: () => jumpToEnd({ loadGameAtIndex }),
        onSpeedUp: () => stepPlaybackRateUi(1),
        onSpeedDown: () => stepPlaybackRateUi(-1),
        onLatestGame: () => goToLatestGame({ showGame }),
        onShowHome: showHome,
    });
    
    setupLogoDance();
}

export function renderGameData() {
    // Timeline
    state.chart = initLiveChart(state.gameData);
    state.teamFullTimeline = buildTeamTimeline(state.gameData);
    state.playerTimelines = buildPlayerTimelines(state.gameData);

    // Player tiles
    generatePlayerTiles();
    applyCurrentGameTeamLabels();
    setupTileExpansion();
    setupPlayerSeriesToggles();
    colourPlayerNamesFromChart();
    setupTeamSeriesFilter();

    // YouTube modal
    setupDraggableModal();
    seekToTime(state.currentTime);

    // Header title
    if (state.selectedGame) {
        const pretty = formatGameDatetime(state.selectedGame.id);
        const fallbackPlayers = Object.values(state.gameData?.players || {})
            .map((p) => p?.name)
            .filter(Boolean);
        const displayTitle =
            getGameDisplayTitle(state.selectedGame, state.events || [], fallbackPlayers) ||
            state.gameData.gameType ||
            "Game";
        const isDisplayTitle = displayTitle !== (state.selectedGame.title || "");
        const titleClass = isDisplayTitle ? "title-game title-game--display" : "title-game";
        const titleEl = document.querySelector('.title');
        if (titleEl) {
            titleEl.innerHTML =
            `<span class="title-date">${pretty}</span>` +
            `<span class="title-sep"> | </span>` +
            `<span class="${titleClass}">${displayTitle}</span>`;
        }
    }
}
