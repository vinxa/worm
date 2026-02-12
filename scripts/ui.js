// ui.js

import { state } from "./state.js";
import { playReplay, seekToTime, handleSkip, clearTimeouts, jumpToStart, jumpToEnd } from "./replayHandler.js";
import { wiggleLogos, setupLogoDance, randomWobble } from "./wormThings.js";
import { loadGameData } from "./main.js";
import { formatGameDatetime, isTypingField } from "./utils.js";
import { initLiveChart, buildTeamTimeline, buildPlayerTimelines } from "./timeline.js";
import { generatePlayerTiles, setupTileExpansion, setupPlayerSeriesToggles, colourPlayerNamesFromChart, setupTeamSeriesFilter } from "./playerTiles.js";
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
const eventFilter = document.getElementById("eventFilter");
const dateFilter = document.getElementById("dateFilter");
const playerFilter = document.getElementById("playerFilter");
const playerOptionsList = document.getElementById("playerOptions");
const headerPlayButton = document.getElementById("headerPlayButton");
const headerSpeedButton = document.getElementById("headerSpeedButton");
const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 4];

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
    const headerBtn = document.getElementById("headerPlayButton");
    if (!state.gameData) return;
    if (state.currentTime >= state.gameData.gameDuration) {
        seekToTime(0);
    }
    if (!state.isPlaying) {
        state.isPlaying = true;
        btn.textContent = "❚❚";
        if (headerBtn) headerBtn.textContent = "❚❚";
        // clear old timeouts
        clearTimeouts();
        // start replay, passing array to fill with timeout IDs
        playReplay(
        state.chart,
        state.gameData,
        state.playbackRate,
        state.replayTimeouts,
        state.currentTime
        );
        if (state.player && typeof state.player.playVideo === "function") {
        state.player.playVideo();
        }
    } else {
        state.isPlaying = false;
        btn.textContent = "▶"; // back to play icon
        if (headerBtn) headerBtn.textContent = "▶";
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

function parseGameStart(game) {
    if (!game || !game.id) return null;
    const m = game.id.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    const [, YYYY, MM, DD, hh, mm] = m;
    const parsed = new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function eventKey(event) {
    return event?.id || event?.name || event?.label || "";
}

function eventLabel(event) {
    return event?.label || event?.name || event?.id || "";
}

function matchesEvent(game, eventId) {
    if (eventId === "none") return true;
    const event = (state.events || []).find((e) => eventKey(e) === eventId);
    if (!event) return false;

    const gameStart = parseGameStart(game);
    if (!gameStart) return false;

    return (event.ranges || []).some((r) => {
        const start = new Date(r.start);
        const end = new Date(r.end);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
        return gameStart >= start && gameStart <= end;
    });
}


function matchesPlayer(game, playerValue) {
    if (playerValue === "all" || !playerValue) return true;
    const list = Array.isArray(game.players) ? game.players : [];
    return list.some((name) => (name || "").toLowerCase() === playerValue.toLowerCase());
}

function currentFilterValues() {
    return {
        type: state.gameFilter || "all",
        event: state.eventFilter || "none",
        date: state.gameDateFilter || "all",
        player: state.gamePlayerFilter || "all",
    };
}

function filterGames(games, overrides = {}) {
    const filters = { ...currentFilterValues(), ...overrides };
    return games.filter(
        (g) =>
            matchesType(g, filters.type) &&
            matchesEvent(g, filters.event) &&
            matchesDate(g, filters.date) &&
            matchesPlayer(g, filters.player)
    );
}

function applyFilter(games) {
    return filterGames(games);
}

function populateFilterOptions(games) {
    if (!gameFilter) return;
    const filters = currentFilterValues();

    const typeScopedGames =
        filters.date === "all" && filters.player === "all" && filters.event === "none"
            ? games
            : filterGames(games, { type: "all" });
    const typeOptionsMap = new Map();
    typeScopedGames.forEach((g) => {
        if (!g.title) return;
        const key = g.title.toLowerCase();
        if (!typeOptionsMap.has(key)) typeOptionsMap.set(key, g.title);
    });
    const typeOptions = ["all", ...typeOptionsMap.values()];
    if (filters.type !== "all" && !typeOptions.includes(filters.type)) {
        typeOptions.push(filters.type);
    }
    gameFilter.innerHTML = typeOptions
        .map((opt) => `<option value="${opt}">${opt === "all" ? "All types" : opt}</option>`)
        .join("");
    gameFilter.value = typeOptions.includes(filters.type) ? filters.type : "all";

    if (dateFilter) {
        const dateScopedGames =
            filters.type === "all" && filters.player === "all" && filters.event === "none"
                ? games
                : filterGames(games, { date: "all" });
        const dateOptions = ["all", ...Array.from(new Set(dateScopedGames.map(gameDateKey)))];
        if (filters.date !== "all" && !dateOptions.includes(filters.date)) {
            dateOptions.push(filters.date);
        }
        dateFilter.innerHTML = dateOptions
            .map((opt) => `<option value="${opt}">${opt === "all" ? "All dates" : opt}</option>`)
            .join("");
        dateFilter.value = dateOptions.includes(filters.date) ? filters.date : "all";
    }

    if (eventFilter) {
        const eventScopedGames =
            filters.type === "all" && filters.date === "all" && filters.player === "all"
                ? games
                : filterGames(games, { event: "none" });

        const options = [{ value: "none", label: "All events" }];
        const seen = new Set(["none"]);
        (state.events || []).forEach((event) => {
            const value = eventKey(event);
            const label = eventLabel(event);
            if (!value || !label || seen.has(value)) return;
            if (!eventScopedGames.some((g) => matchesEvent(g, value))) return;
            seen.add(value);
            options.push({ value, label });
        });
        if (filters.event !== "none" && !options.some((opt) => opt.value === filters.event)) {
            const selectedEvent = (state.events || []).find((event) => eventKey(event) === filters.event);
            options.push({
                value: filters.event,
                label: selectedEvent ? eventLabel(selectedEvent) : filters.event,
            });
        }

        eventFilter.innerHTML = options
            .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
            .join("");

        eventFilter.value = options.some((opt) => opt.value === filters.event) ? filters.event : "none";
    }

    if (playerFilter) {
        const playerScopedGames =
            filters.type === "all" && filters.date === "all" && filters.event === "none"
                ? games
                : filterGames(games, { player: "all" });
        const playersSet = new Set();
        playerScopedGames.forEach((g) => {
            (Array.isArray(g.players) ? g.players : []).forEach((name) => {
                if (name) playersSet.add(name);
            });
        });
        const playerOptions = ["all", ...playersSet];
        if (playerOptionsList) {
            playerOptionsList.innerHTML = playerOptions
                .filter((opt) => opt !== "all")
                .map((opt) => `<option value="${opt}"></option>`)
                .join("");
        }
        const currentText = state.gamePlayerFilterText || "";
        playerFilter.value = currentText;
        // if text emptied by user, also reset filter
        if (currentText === "") {
            state.gamePlayerFilter = "all";
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

    if (headerPlayButton) {
        headerPlayButton.addEventListener("click", clickPlayButton);
    }

    const skipStartButton = document.getElementById("skipStartButton");
    if (skipStartButton) skipStartButton.addEventListener("click", () => jumpToStart());

    const skipEndButton = document.getElementById("skipEndButton");
    if (skipEndButton) skipEndButton.addEventListener("click", () => jumpToEnd());

    const speedButton = document.getElementById("speedButton");
    const applySpeedLabel = () => {
        const label = `${state.playbackRate}x`;
        if (speedButton) speedButton.textContent = label;
        if (headerSpeedButton) headerSpeedButton.textContent = label;
    };
    const bindSpeedButton = (btn) => {
        if (!btn) return;
        btn.addEventListener("click", () => {
        const idx = SPEED_OPTIONS.indexOf(state.playbackRate);
        const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
        state.playbackRate = next;
        applySpeedLabel();
        if (state.isPlaying) {
            clearTimeouts();
            playReplay(state.chart, state.gameData, state.playbackRate, state.replayTimeouts, state.currentTime);
        }
        });
    };
    applySpeedLabel();
    bindSpeedButton(speedButton);
    bindSpeedButton(headerSpeedButton);

    if (nextGameBtn) {
        nextGameBtn.addEventListener("click", () => {
            if (state.latestGame) {
                state.selectedPlayers = new Set();
                showGame(state.latestGame);
            }
        });
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
    setupTeamSeriesFilter();

    // YouTube modal
    setupDraggableModal();
    seekToTime(state.currentTime);

    // Header title
    if (state.selectedGame && state.gameData.gameType) {
        const pretty = formatGameDatetime(state.selectedGame.id);
        const titleEl = document.querySelector('.title');
        if (titleEl) {
            titleEl.innerHTML =
            `<span class="title-date">${pretty}</span>` +
            `<span class="title-sep"> | </span>` +
            `<span class="title-game">${state.gameData.gameType}</span>`;
        }
    }
}
