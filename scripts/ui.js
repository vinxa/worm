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

function updateNextGameButtonVisibility() {
    if (!nextGameBtn) return;
    const shouldShow =
        !!state.selectedGame &&
        !!state.latestGame &&
        state.selectedGame.id !== state.latestGame.id;
    nextGameBtn.style.display = shouldShow ? "inline-block" : "none";
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
    if (nextGameBtn) nextGameBtn.style.display = "none";
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
    updateNextGameButtonVisibility();
    wiggleLogos();
}

// build the grid of tiles on index page
export function buildGrid(games) {
    const grid = document.getElementById("gamesGrid");
    grid.innerHTML = ""; // clear any old tiles
    games.forEach((game) => {
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

    document.addEventListener("keydown", (e) => keyboardControls(e));
    
    setupLogoDance();
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
