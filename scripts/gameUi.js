import { state } from "./state.js";
import { loadGameData } from "./main.js";
import { formatGameDatetime } from "./utils.js";
import { initLiveChart, buildTeamTimeline, buildPlayerTimelines } from "./timeline.js";
import { generatePlayerTiles, setupPlayerSeriesToggles, setupTeamSeriesFilter } from "./playerTiles.js";
import { setupDraggableModal } from "./video.js";
import { getGameDisplayTitle, getTeamLabelMapForGame } from "./displayLabels.js";
import { wiggleLogos } from "./wormThings.js";
import { seekToTime, setPlaybackRate, stepPlaybackRate, togglePlayback } from "./replayHandler.js";

const gameHeader = document.querySelector("body > .app-header");
const gameSections = [
    document.querySelector(".top-section"),
    document.querySelector(".timeline-section"),
];
const leftBtn = document.querySelector(".nav-button.left");
const nextGameBtn = document.querySelector(".next-game-button");
const headerPlayButton = document.getElementById("headerPlayButton");
const headerSpeedButton = document.getElementById("headerSpeedButton");
const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 4];

export function updateNextGameButtonVisibility(fade = false, flash = false) {
    if (!nextGameBtn) return;
    const shouldShow =
        !!state.selectedGame &&
        !!state.latestGame &&
        state.selectedGame.id !== state.latestGame.id;

    if (shouldShow) {
        if (fade) {
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

export function showGame(game) {
    const homeView = document.getElementById("home-view");
    state.selectedGame = game;
    homeView.style.display = "none";
    leftBtn.style.display = "inline-block";
    gameHeader.style.display = "flex";
    gameSections.forEach((s) => (s.style.display = ""));
    loadGameData(game.dataPath);
    updateNextGameButtonVisibility(false, false);
    wiggleLogos();
}

export function renderGameData() {
    state.chart = initLiveChart(state.gameData);
    state.teamFullTimeline = buildTeamTimeline(state.gameData);
    state.playerTimelines = buildPlayerTimelines(state.gameData);

    generatePlayerTiles();
    applyCurrentGameTeamLabels();
    setupPlayerSeriesToggles();
    setupTeamSeriesFilter();

    setupDraggableModal();
    seekToTime(state.currentTime);

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
        const titleEl = document.querySelector(".title");
        if (titleEl) {
            titleEl.innerHTML =
                `<span class="title-date">${pretty}</span>` +
                `<span class="title-sep"> | </span>` +
                `<span class="${titleClass}">${displayTitle}</span>`;
        }
    }
}

export function applySpeedLabel() {
    const label = `${state.playbackRate}x`;
    const speedButton = document.getElementById("speedButton");
    if (speedButton) speedButton.textContent = label;
    if (headerSpeedButton) headerSpeedButton.textContent = label;
}

export function stepPlaybackRateUi(direction) {
    stepPlaybackRate(direction, { speeds: SPEED_OPTIONS });
    applySpeedLabel();
}

export function clickPlayButton() {
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

export function bindPlaybackButtons() {
    const playButton = document.getElementById("playButton");
    if (playButton) playButton.addEventListener("click", clickPlayButton);
    if (headerPlayButton) headerPlayButton.addEventListener("click", clickPlayButton);

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
