// ui.js

import { state } from "./state.js";
import { playReplay, seekToTime, handleSkip, clearTimeouts } from "./replayHandler.js";
import { wiggleLogos, setupLogoDance, randomWobble } from "./wormThings.js";
import { loadGameData } from "./main.js";
import { formatGameDatetime, isTypingField } from "./utils.js";
import { initLiveChart, buildTeamTimeline, buildPlayerTimelines } from "./timeline.js";
import { generatePlayerTiles, setupTileExpansion, setupPlayerSeriesToggles, colourPlayerNamesFromChart } from "./playerTiles.js";
import { setupDraggableModal } from "./video.js";

// Shared UI elements
const gameHeader = document.querySelector("body > .app-header");
const gameSections = [
    document.querySelector(".top-section"),
    document.querySelector(".timeline-section"),
];
const homeView = document.getElementById("home-view");
const leftBtn = document.querySelector(".nav-button.left");
const nextGameBtn = document.querySelector(".next-game-button");
const gameFilter = document.getElementById("gameFilter");
const dateFilter = document.getElementById("dateFilter");

function updateNextGameButtonVisibility(fade = false, flash = false) {
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
    if (!state.gameData) return;
    if (state.currentTime >= state.gameData.gameDuration) {
        seekToTime(0);
    }
    if (!state.isPlaying) {
        state.isPlaying = true;
        btn.textContent = "❚❚";
        // clear old timeouts
        clearTimeouts();
        // start replay, passing array to fill with timeout IDs
        playReplay(
        state.chart,
        state.gameData,
        1,
        state.replayTimeouts,
        state.currentTime
        );
        if (state.player && typeof state.player.playVideo === "function") {
        state.player.playVideo();
        }
    } else {
        state.isPlaying = false;
        btn.textContent = "▶"; // back to play icon
        clearTimeouts();
        if (state.player && typeof state.player.pauseVideo === "function") {
        state.player.pauseVideo();
        }
        // cancel pending events
        clearTimeouts();
    }
}

function keyboardControls(e) {
    switch (e.code) {
        case "Space":
            e.preventDefault();
            if (state.currentTime >= state.gameData.gameDuration) {
                seekToTime(0);
            }
            document.getElementById("playButton").click();
            break;
        case "ArrowLeft":
            e.preventDefault();
            handleSkip(-15);
            break;
        case "ArrowRight":
            e.preventDefault();
            handleSkip(+15);
            break;
        case "Backspace":
            if (!isTypingField(e.target)) {
                e.preventDefault();
                showHome();
                break;
            }
    }
}

export function showHome() {
    homeView.style.display = "block";
    leftBtn.style.display = "none";
    gameHeader.style.display = "none";
    gameSections.forEach((s) => (s.style.display = "none"));
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

function gameDateLabel(game) {
    return formatGameDatetime(game.id);
}

function gameDateKey(game) {
    return gameDateLabel(game).replace(/[\u00A0\s]*\d{2}:\d{2}$/, "");
}

function matchesType(game, typeValue) {
    if (typeValue === "all") return true;
    return (game.title || "").toLowerCase() === typeValue.toLowerCase();
}

function matchesDate(game, dateValue) {
    if (dateValue === "all") return true;
    return gameDateKey(game) === dateValue;
}

function applyFilter(games) {
    const typeValue = state.gameFilter || "all";
    const dateValue = state.gameDateFilter || "all";
    return games.filter((g) => matchesType(g, typeValue) && matchesDate(g, dateValue));
}

function populateFilterOptions(games) {
    if (!gameFilter) return;
    const currentType = state.gameFilter || "all";
    const currentDate = state.gameDateFilter || "all";

    const typeScopedGames =
        currentDate === "all"
            ? games
            : games.filter((g) => matchesDate(g, currentDate));
    const typeOptionsMap = new Map();
    typeScopedGames.forEach((g) => {
        if (!g.title) return;
        const key = g.title.toLowerCase();
        if (!typeOptionsMap.has(key)) typeOptionsMap.set(key, g.title);
    });
    const typeOptions = ["all", ...typeOptionsMap.values()];
    gameFilter.innerHTML = typeOptions
        .map((opt) => `<option value="${opt}">${opt === "all" ? "All types" : opt}</option>`)
        .join("");
    if (typeOptions.includes(currentType)) {
        gameFilter.value = currentType;
    } else {
        state.gameFilter = "all";
        gameFilter.value = "all";
    }

    if (dateFilter) {
        const dateScopedGames =
            currentType === "all"
                ? games
                : games.filter((g) => matchesType(g, currentType));
        const dateOptions = ["all", ...Array.from(new Set(dateScopedGames.map(gameDateKey)))];
        dateFilter.innerHTML = dateOptions
            .map((opt) => `<option value="${opt}">${opt === "all" ? "All dates" : opt}</option>`)
            .join("");
        if (dateOptions.includes(currentDate)) {
            dateFilter.value = currentDate;
        } else {
            state.gameDateFilter = "all";
            dateFilter.value = "all";
        }
    }
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
        const raw = game.title || "";

        const gameLine = document.createElement("span");
        gameLine.textContent = formatGameDatetime(game.id);

        const rawLine = document.createElement("span");
        rawLine.textContent = raw;

        tile.appendChild(gameLine);
        tile.appendChild(rawLine);
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

    const playButton = document.getElementById("playButton");
    playButton.addEventListener("click", clickPlayButton);

    const rewindButton = document.getElementById("rewindButton");
    rewindButton.addEventListener("click", () => handleSkip(-15));

    const forwardButton = document.getElementById("forwardButton");
    forwardButton.addEventListener("click", () => handleSkip(+15));

    if (nextGameBtn) {
        nextGameBtn.addEventListener("click", () => {
            if (state.latestGame) showGame(state.latestGame);
        });
    }

    if (gameFilter) {
        gameFilter.addEventListener("change", (e) => {
            state.gameFilter = e.target.value || "all";
            buildGrid(state.games || []);
        });
    }

    if (dateFilter) {
        dateFilter.addEventListener("change", (e) => {
            state.gameDateFilter = e.target.value || "all";
            buildGrid(state.games || []);
        });
    }

    document.addEventListener("keydown", (e) => keyboardControls(e));
    
    setupLogoDance();
}

export function refreshNextGameButton(fade = false, flash = false) {
    updateNextGameButtonVisibility(fade, flash);
}

export function renderGameData() {
    // Timeline
    state.chart = initLiveChart(state.gameData);
    state.teamFullTimeline = buildTeamTimeline(state.gameData);
    state.playerTimelines = buildPlayerTimelines(state.gameData);

    // Player tiles
    generatePlayerTiles();
    setupTileExpansion();
    setupPlayerSeriesToggles();
    colourPlayerNamesFromChart();

    // YouTube modal
    setupDraggableModal();
    seekToTime(state.currentTime);

    // Header title
    if (state.selectedGame && state.gameData.gameType) {
        const pretty = formatGameDatetime(state.selectedGame.id);
        document.querySelector('.title').textContent =
            `${pretty}    |    ${state.gameData.gameType}`;
    }
}
