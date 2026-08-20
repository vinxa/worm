import { state } from "./state.js";
import { formatGameDatetime, getGameDuration, getLivePresentationTime } from "./utils.js";
import {
    handleSkip,
    jumpToStart,
    jumpToEnd,
    goToLatestGame,
    resumeLivePlayback,
    seekToTime,
    setPlaybackRate,
    stepPlaybackRate,
    togglePlayback,
    updatePlayButtonsLabel,
    updateSpeedButtons,
} from "./replayHandler.js";
import { setupKeyboardControls, setupKeyboardShortcutsModal } from "./keyboard.js";
import {
    initLiveChart,
    buildTeamTimeline,
    buildPlayerTimelines,
    setupComparisonDetailsToggle,
    setupSplitWormToggle,
} from "./timeline.js";
import {
    applySelectedTileState,
    generatePlayerTiles,
    setupPlayerSeriesToggles,
    setupTeamSeriesFilter,
    stopPlayerTileOrderChecks,
} from "./playerTiles.js";
import { applyFilter, populateFilterOptions, setupFilterListeners } from "./gameFilters.js";
import { hasActiveFilters } from "./filterSession.js";
import { gameHasFollowedPlayer, refreshFavouritesPanel, setupFavourites } from "./favourites.js";
import {
    getEventTeamColourMap,
    getGameDisplayTitle,
    getMatchedEventTeamNames,
    getTeamLabelMapForGame,
} from "./displayLabels.js";
import {
    isSelectedCurrentLiveGame,
    setFollowLiveGames,
    subscribeToLiveGame,
    unsubscribeFromLiveGame,
} from "./live.js";
import { clearGameUrl, getGameHref, getShareHref, setGameUrl } from "./routing.js";
import { summaryPlayerAliasMap, summaryPlayerRecordMap } from "./summaryPlayers.js";
import { closeYouTubeModal, getShareableYouTubeUrl, setupDraggableModal } from "./video.js";
import {
    getLivePresentationDelaySeconds,
    setLivePresentationDelaySeconds,
} from "./liveDelay.js";

const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 4];
const GAME_BATCH_SIZE = 60;
const gameHeader = document.querySelector("body > .app-header");
const gameSections = [
    document.querySelector(".top-section"),
    document.querySelector(".timeline-section"),
];
const homeView = document.getElementById("home-view");
const leftNavigationButton = document.querySelector(".nav-button.left");
const nextGameBtn = document.querySelector(".next-game-button");
const liveCountdown = document.getElementById("liveCountdown");
const followLiveControl = document.getElementById("followLiveControl");
const followLiveCheckbox = document.getElementById("followLiveCheckbox");
const liveDelayInput = document.getElementById("liveDelayInput");
const liveDelaySaved = document.getElementById("liveDelaySaved");
const liveSettings = document.querySelector(".global-live-settings");
const LIVE_SETTINGS_ANIMATION_MS = 180;
const logoDances = [
    { name: "worm-spin", duration: "1.1s", easing: "ease-in-out" },
    { name: "worm-corkscrew", duration: "1s", easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    { name: "worm-burrow-boing", duration: "1.15s", easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    { name: "dance1", duration: "0.8s", easing: "ease-in-out" },
    { name: "dance2", duration: "0.8s", easing: "ease-in-out" },
    { name: "dance3", duration: "0.8s", easing: "ease-in-out" },
];
const previousDanceIndexes = new WeakMap();
let loadGameData;
let visibleGameLimit = GAME_BATCH_SIZE;

function updateLiveCountdown() {
    if (!liveCountdown) return;
    const isLive = isSelectedCurrentLiveGame(state.selectedGame, state.liveGameKey);
    const selectedKey = state.selectedGame?.gameKey;
    const dataMatchesSelected = !selectedKey || state.gameData?.gameKey === selectedKey;
    const data = dataMatchesSelected ? (state.gameData || state.selectedGame) : state.selectedGame;
    const duration = getGameDuration(data);

    liveCountdown.hidden = !isLive || duration <= 0;
    if (!liveCountdown.hidden) {
        const seconds = Math.max(0, Math.ceil(
            duration - getLivePresentationTime(data, state.selectedGame)
        ));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const time = `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
        liveCountdown.textContent = hours ? `${hours}:${time}` : time;
    }
}

function playRandomLogoDance(logo) {
    const previousDanceIndex = previousDanceIndexes.get(logo) ?? -1;
    const dances = logoDances.filter((_, index) => index !== previousDanceIndex);
    const dance = dances[Math.floor(Math.random() * dances.length)];

    previousDanceIndexes.set(logo, logoDances.indexOf(dance));
    logo.classList.remove("wiggle-on-load");
    logo.style.animation = "";
    void logo.offsetWidth;
    logo.style.animation = `${dance.name} ${dance.duration} ${dance.easing}`;
}

function wiggleMatchingLogos(selector) {
    document.querySelectorAll(selector).forEach((logo) => {
        playRandomLogoDance(logo);
        logo.addEventListener("animationend", () => {
            logo.style.animation = "";
        }, { once: true });
    });
}

export function wiggleLogos() {
    wiggleMatchingLogos(".app-logo");
}

export function buildGrid(games, highlightIds = [], { resetLimit = false } = {}) {
    if (!state.gamesIndexLoaded) return;
    const grid = document.getElementById("gamesGrid");
    if (resetLimit) visibleGameLimit = GAME_BATCH_SIZE;
    const highlightSet = new Set(highlightIds);
    const gamesMatchingGameFilters = applyFilter(games, { favourites: false });
    refreshFavouritesPanel(gamesMatchingGameFilters, {
        allGames: games,
        restrictToGames: hasActiveFilters({ includeFavourites: false }),
    });
    populateFilterOptions(games);

    const filteredGames = applyFilter(games);
    const visibleGames = filteredGames.slice(0, visibleGameLimit);
    const fragment = document.createDocumentFragment();
    visibleGames.forEach((game) => {
        const tile = document.createElement("a");
        tile.className = "game-tile";
        tile.dataset.gameId = game.id;
        tile.href = getGameHref(game);
        if (gameHasFollowedPlayer(game)) tile.classList.add("has-favourite");
        if (isSelectedCurrentLiveGame(game, state.liveGameKey)) {
            tile.classList.add("is-live");
        }

        const gameLine = document.createElement("span");
        gameLine.className = "game-tile-date";
        gameLine.textContent = formatGameDatetime(game.id);

        const rawLine = document.createElement("span");
        rawLine.className = "game-title-text";
        const raw = getGameDisplayTitle(game, state.events);
        const matchedTeams = getMatchedEventTeamNames(game, state.events);
        if (!matchedTeams.length) {
            rawLine.textContent = raw;
        } else {
            const prefix = document.createElement("span");
            prefix.textContent = raw.includes(":") ? `${raw.split(":")[0]}: ` : "";
            rawLine.appendChild(prefix);
            const teamColourMap = getEventTeamColourMap(game, state.events);
            matchedTeams.forEach((teamName, index) => {
                const teamNameLine = document.createElement("div");
                const fullName = String(teamName || "").trim();
                const shortName = fullName.length > 20 ? `${fullName.slice(0, 20)}...` : fullName;
                teamNameLine.className = `game-title-team game-title-team--${index % 3}`;
                teamNameLine.textContent = shortName;
                if (teamColourMap[teamName]) teamNameLine.style.color = teamColourMap[teamName];
                if (shortName !== fullName) teamNameLine.title = fullName;
                rawLine.appendChild(teamNameLine);
            });
            requestAnimationFrame(() => {
                let sizePx = 12.5;
                let iterations = 0;
                rawLine.style.fontSize = `${sizePx}px`;
                while (
                    rawLine.scrollHeight > rawLine.clientHeight + 0.5 &&
                    sizePx > 6 &&
                    iterations++ < 30
                ) {
                    rawLine.style.fontSize = `${sizePx -= 0.5}px`;
                }
            });
        }

        tile.append(gameLine, rawLine);
        tile.addEventListener("click", (event) => {
            if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
            ) return;
            event.preventDefault();
            showGame(game);
        });
        fragment.appendChild(tile);

        if (highlightSet.has(game.id)) {
            tile.classList.add("flash-new");
            setTimeout(() => tile.classList.remove("flash-new"), 3000);
        }
    });
    grid.replaceChildren(fragment);

    const status = document.getElementById("gamesGridStatus");
    const loadMore = document.getElementById("loadMoreGames");
    if (status) {
        status.textContent = filteredGames.length
            ? `Showing ${visibleGames.length} of ${filteredGames.length} games`
            : "No games match these filters";
    }
    if (loadMore) loadMore.hidden = visibleGames.length >= filteredGames.length;
}

export function showGamesIndexRetrying() {
    const loader = document.getElementById("gamesIndexLoading");
    const message = document.getElementById("gamesIndexLoadingMessage");
    if (!loader || !message) return;
    loader.classList.add("is-retrying");
    message.textContent = "Couldn't load games. Retrying…";
}

export function showHome({
    unsubscribe = true,
    updateHistory = true,
    replaceHistory = false,
    disableLiveFollow = true,
} = {}) {
    if (disableLiveFollow) setFollowLiveGames(false);
    if (unsubscribe) unsubscribeFromLiveGame();
    stopPlayerTileOrderChecks();
    if (updateHistory) clearGameUrl({ replace: replaceHistory });
    document.body.classList.remove("game-view-active");
    homeView.style.display = "block";
    leftNavigationButton.style.display = "none";
    gameHeader.style.display = "none";
    updateLiveCountdown();
    gameSections.forEach((section) => (section.style.display = "none"));
    state.selectedPlayers = new Set();
    updateNextGameButtonVisibility();
    closeYouTubeModal();
    if (state.gamesIndexLoaded) wiggleMatchingLogos(".home-section .app-logo");
}

export function updateNextGameButtonVisibility(fade = false, flash = false) {
    if (!nextGameBtn) return;
    const isLive = isSelectedCurrentLiveGame(state.selectedGame, state.liveGameKey);
    const isLatest = Boolean(state.selectedGame && state.latestGame &&
        state.selectedGame.id === state.latestGame.id);
    const isLatestLive = isSelectedCurrentLiveGame(state.latestGame, state.liveGameKey);
    nextGameBtn.classList.toggle("is-live", isLatestLive);
    nextGameBtn.title = isLatestLive ? "Latest Game — Live (L)" : "Latest Game (L)";
    nextGameBtn.setAttribute("aria-label", isLatestLive ? "Latest Game — Live" : "Latest Game");
    if (followLiveControl) followLiveControl.hidden = !isLatest;
    if (followLiveCheckbox) followLiveCheckbox.checked = state.followLiveGames;
    nextGameBtn.hidden = isLive;
    const shouldShow = !isLive && state.selectedGame && state.latestGame &&
        state.selectedGame.id !== state.latestGame.id;

    if (!shouldShow) {
        nextGameBtn.classList.remove("is-visible", "flash-new");
        return;
    }
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
}

export function showGame(game, {
    updateHistory = true,
    replaceHistory = false,
    viewState = null,
} = {}) {
    if (!isSelectedCurrentLiveGame(game, state.liveGameKey)) setFollowLiveGames(false);
    if (state.liveSubscribed && game?.gameKey !== state.liveGameKey) unsubscribeFromLiveGame();
    state.selectedGame = game;
    if (updateHistory) setGameUrl(game, { replace: replaceHistory });
    document.body.classList.add("game-view-active");
    homeView.style.display = "none";
    leftNavigationButton.style.display = "inline-flex";
    gameHeader.style.display = "flex";
    updateLiveCountdown();
    gameSections.forEach((section) => (section.style.display = ""));

    const isLiveGame = isSelectedCurrentLiveGame(game, state.liveGameKey);
    const hasTemporaryGameData = Boolean(game.gameKey && !game.dataPath);
    if (isLiveGame || hasTemporaryGameData) {
        state.liveGameKey = game.gameKey || state.liveGameKey;
        if (isLiveGame) subscribeToLiveGame();
        let liveData = state.liveGameData?.gameKey === game.gameKey
            ? state.liveGameData
            : state.gameData?.gameKey === game.gameKey
                ? state.gameData
                : null;
        if (!liveData) {
            const teamEntries = Array.isArray(game?.teams)
                ? game.teams.map((team) => [team?.id, team])
                : Object.entries(game?.teams || {});
            const teams = teamEntries.filter(([id]) => id != null).map(([id, team]) => ({
                id: String(id),
                name: team?.name || id,
                color: team?.color || "",
            }));
            const players = {};
            const recordsById = summaryPlayerRecordMap(game?.players);
            const aliasesById = summaryPlayerAliasMap(game?.players);

            if (Object.keys(aliasesById).length) {
                Object.entries(aliasesById).forEach(([id, name]) => {
                    players[id] = {
                        id,
                        name,
                        team: "",
                        ...(recordsById[id]?.memberId ? { memberId: recordsById[id].memberId } : {}),
                    };
                });
                teamEntries.forEach(([teamId, team]) => {
                    (Array.isArray(team?.players) ? team.players : []).forEach((playerId) => {
                        const id = String(playerId);
                        players[id] = {
                            id,
                            name: aliasesById[id] ?? players[id]?.name ?? id,
                            team: String(teamId),
                        };
                    });
                });
            } else {
                teamEntries.forEach(([teamId, team]) => {
                    (Array.isArray(team?.players) ? team.players : []).forEach((name, index) => {
                        const id = `${teamId}-${index}`;
                        players[id] = { id, name, team: String(teamId) };
                    });
                });
            }
            liveData = {
                ...game,
                teams,
                players,
                active_bases: [],
                events: [],
                gameDuration: Number(game?.gameDuration) || 0,
            };
        }
        loadGameData("", {
            prefetchedData: liveData,
            livePlayback: isLiveGame,
            initialViewState: viewState,
        });
    } else {
        loadGameData(game.dataPath, { initialViewState: viewState });
    }
    updateNextGameButtonVisibility();
    wiggleLogos();
}

export function renderGameData() {
    updateLiveCountdown();
    state.chart = initLiveChart(state.gameData);
    state.teamFullTimeline = buildTeamTimeline(state.gameData);
    state.playerTimelines = buildPlayerTimelines(state.gameData);

    generatePlayerTiles();
    const teamScores = document.querySelector(".team-scores");
    if (teamScores) {
        const teamLabelMap = getTeamLabelMapForGame(
            state.selectedGame,
            state.gameData?.players || {},
            state.events
        );
        teamScores.replaceChildren(...(state.gameData?.teams || []).map((team) => {
            const item = document.createElement("li");
            item.dataset.teamId = team.id;
            const fullName = teamLabelMap[team.id] || team.name || team.id;
            const name = document.createElement("span");
            name.className = "team-name";
            name.textContent = fullName;
            name.title = fullName;
            const tags = document.createElement("span");
            tags.className = "team-tags";
            tags.textContent = "0-0";
            const score = document.createElement("span");
            score.className = "team-score";
            score.textContent = "0";
            item.append(name, tags, score);
            return item;
        }));
    }
    setupPlayerSeriesToggles();
    setupTeamSeriesFilter();
    applySelectedTileState();
    setupDraggableModal();
    seekToTime(state.currentTime);

    if (!state.selectedGame) return;
    const fallbackPlayers = Object.values(state.gameData?.players || {})
        .map((player) => player?.name)
        .filter(Boolean);
    const displayTitle = getGameDisplayTitle(
        state.selectedGame,
        state.events,
        fallbackPlayers
    ) || state.gameData.gameType || "Game";
    const title = document.querySelector(".title");
    if (!title) return;

    const matchedTeams = getMatchedEventTeamNames(
        state.selectedGame,
        state.events,
        fallbackPlayers
    );
    const teamColourMap = getEventTeamColourMap(
        state.selectedGame,
        state.events,
        state.gameData?.players || {}
    );
    const date = document.createElement("span");
    date.className = "title-date";
    date.textContent = formatGameDatetime(state.selectedGame.id);
    const separator = document.createElement("span");
    separator.className = "title-sep";
    separator.textContent = " | ";
    const gameTitle = document.createElement("span");
    gameTitle.className = displayTitle !== (state.selectedGame.title || "")
        ? "title-game title-game--display"
        : "title-game";

    if (!matchedTeams.length) {
        gameTitle.textContent = displayTitle;
    } else {
        gameTitle.append(displayTitle.includes(":") ? `${displayTitle.split(":")[0]}: ` : "");
        matchedTeams.forEach((teamName, index) => {
            if (index) gameTitle.append(" v ");
            const team = document.createElement("span");
            team.className = "title-game-team";
            team.textContent = teamName;
            if (teamColourMap[teamName]) team.style.color = teamColourMap[teamName];
            gameTitle.appendChild(team);
        });
    }
    title.replaceChildren(date, separator, gameTitle);
}

function clickPlayButton() {
    const isPlaying = togglePlayback();
    if (isPlaying === null) return;
    updatePlayButtonsLabel(isPlaying ? "❚❚" : "▶");
    const action = isPlaying ? "playVideo" : "pauseVideo";
    if (typeof state.player?.[action] === "function") state.player[action]();
}

async function shareCurrentPage(button) {
    const selectedPlayers = [...state.selectedPlayers];
    const youtubeUrl = getShareableYouTubeUrl(
        document.getElementById("youtubeUrl")?.value || ""
    );
    const shareUrl = getShareHref({
        time: Number(state.currentTime.toFixed(3)),
        playbackRate: state.playbackRate,
        youtubeUrl,
        selectedPlayers,
        selectedTeams: selectedPlayers.length ? [] : [...(state.hiddenTeams || [])],
        splitWorm: state.splitWorm,
        comparisonDetails: state.comparisonDetails,
    });

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(shareUrl);
        } else {
            const input = document.createElement("textarea");
            Object.assign(input.style, { position: "fixed", opacity: "0" });
            input.value = shareUrl;
            input.readOnly = true;
            document.body.appendChild(input);
            input.select();
            document.execCommand("copy");
            input.remove();
        }
        button.classList.add("is-copied");
        button.title = "Link copied";
        button.setAttribute("aria-label", "Link copied");
        const toast = document.getElementById("shareToast");
        if (toast) {
            toast.classList.remove("is-visible");
            void toast.offsetWidth;
            toast.classList.add("is-visible");
        }
        window.setTimeout(() => {
            button.classList.remove("is-copied");
            button.title = "Share this game";
            button.setAttribute("aria-label", "Share this game");
        }, 1600);
    } catch (error) {
        console.error("Unable to copy the game URL:", error);
    }

    if (navigator.share) {
        try {
            await navigator.share({
                title: document.title,
                url: shareUrl,
            });
            return;
        } catch (error) {
            if (error?.name === "AbortError") return;
        }
    }
}

function loadAdjacentGame(offset) {
    const games = state.games;
    const currentIndex = games.findIndex((game) => game.id === state.selectedGame?.id);
    if (currentIndex < 0) return false;
    const index = currentIndex + offset;
    if (index < 0 || index >= games.length) return false;
    state.selectedPlayers = new Set();
    showGame(games[index]);
    return true;
}

export function initUI(gameLoader) {
    loadGameData = gameLoader;
    updateLiveCountdown();
    setupComparisonDetailsToggle();
    setupSplitWormToggle();
    window.setInterval(updateLiveCountdown, 250);
    leftNavigationButton.addEventListener("click", () => showHome());

    [document.getElementById("playButton"), document.getElementById("headerPlayButton")]
        .forEach((button) => button?.addEventListener("click", clickPlayButton));
    [document.getElementById("resumeLiveButton"), document.getElementById("headerResumeLiveButton")]
        .forEach((button) => button?.addEventListener("click", resumeLivePlayback));
    [document.getElementById("speedButton"), document.getElementById("headerSpeedButton")]
        .forEach((button) => button?.addEventListener("click", () => {
            const currentIndex = SPEED_OPTIONS.indexOf(state.playbackRate);
            setPlaybackRate(SPEED_OPTIONS[((currentIndex < 0 ? 0 : currentIndex) + 1) % SPEED_OPTIONS.length]);
        }));
    updateSpeedButtons();
    if (liveDelayInput) {
        liveDelayInput.value = String(getLivePresentationDelaySeconds());
        const saveLiveDelay = () => {
            liveDelayInput.value = String(
                setLivePresentationDelaySeconds(liveDelayInput.value)
            );
            updateLiveCountdown();
            if (liveDelaySaved) {
                liveDelaySaved.textContent = `Saved — ${liveDelayInput.value} seconds`;
                liveDelaySaved.classList.remove("is-visible");
                void liveDelaySaved.offsetWidth;
                liveDelaySaved.classList.add("is-visible");
            }
        };
        liveDelayInput.addEventListener("input", () => {
            liveDelaySaved?.classList.remove("is-visible");
        });
        liveDelayInput.addEventListener("change", saveLiveDelay);
        document.querySelectorAll("[data-delay-step]").forEach((button) => {
            button.addEventListener("click", () => {
                if (button.dataset.delayStep === "up") liveDelayInput.stepUp();
                else liveDelayInput.stepDown();
                saveLiveDelay();
                liveDelayInput.focus();
            });
        });
    }
    if (liveSettings) {
        const summary = liveSettings.querySelector("summary");
        let closeTimer = null;
        const closeLiveSettings = () => {
            window.clearTimeout(closeTimer);
            liveSettings.classList.add("is-closing");
            closeTimer = window.setTimeout(() => {
                liveSettings.open = false;
                liveSettings.classList.remove("is-closing");
            }, LIVE_SETTINGS_ANIMATION_MS);
        };
        summary?.addEventListener("click", (event) => {
            event.preventDefault();
            window.clearTimeout(closeTimer);
            if (liveSettings.open) return closeLiveSettings();
            liveSettings.classList.remove("is-closing");
            liveSettings.open = true;
        });
        document.addEventListener("click", (event) => {
            if (liveSettings.open && !liveSettings.contains(event.target)) closeLiveSettings();
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && liveSettings.open) {
                closeLiveSettings();
                summary?.focus();
            }
        });
    }
    if (followLiveCheckbox) {
        followLiveCheckbox.checked = state.followLiveGames;
        followLiveCheckbox.addEventListener("change", () => {
            setFollowLiveGames(followLiveCheckbox.checked);
        });
    }

    window.addEventListener("orientationchange", wiggleLogos);
    document.querySelectorAll(".app-logo").forEach((logo) => {
        logo.addEventListener("mouseenter", () => playRandomLogoDance(logo));
        logo.addEventListener("animationend", () => {
            logo.style.animation = "";
        });
    });
    document.querySelectorAll(".portrait-orientation-logo").forEach((logo) => {
        logo.addEventListener("pointerdown", () => {
            logo.classList.remove("wiggle-on-tap");
            void logo.offsetWidth;
            logo.classList.add("wiggle-on-tap");
        });
        logo.addEventListener("animationend", () => logo.classList.remove("wiggle-on-tap"));
    });

    const patchNotesModal = document.getElementById("patchNotesModal");
    const patchNotesButton = document.getElementById("patchNotesButton");
    const patchNotesClose = document.getElementById("patchNotesClose");
    if (patchNotesModal && patchNotesButton && patchNotesClose) {
        const closePatchNotes = () => {
            if (patchNotesModal.open && !patchNotesModal.classList.contains("is-closing")) {
                patchNotesModal.classList.add("is-closing");
            }
        };
        patchNotesButton.addEventListener("click", () => {
            patchNotesModal.classList.remove("is-closing");
            patchNotesModal.showModal();
        });
        patchNotesClose.addEventListener("click", closePatchNotes);
        patchNotesModal.addEventListener("cancel", (event) => {
            event.preventDefault();
            closePatchNotes();
        });
        patchNotesModal.addEventListener("animationend", (event) => {
            if (event.target !== patchNotesModal || !patchNotesModal.classList.contains("is-closing")) return;
            patchNotesModal.close();
            patchNotesModal.classList.remove("is-closing");
        });
        patchNotesModal.addEventListener("click", (event) => {
            const bounds = patchNotesModal.getBoundingClientRect();
            if (
                event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom
            ) closePatchNotes();
        });
    }
    setupKeyboardShortcutsModal();

    const shareButton = document.getElementById("shareButton");
    if (shareButton) {
        shareButton.addEventListener("click", () => shareCurrentPage(shareButton));
    }

    const rewindButton = document.getElementById("rewindButton");
    rewindButton.addEventListener("click", () => handleSkip(-15));

    const forwardButton = document.getElementById("forwardButton");
    forwardButton.addEventListener("click", () => handleSkip(+15));

    const skipStartButton = document.getElementById("skipStartButton");
    if (skipStartButton) skipStartButton.addEventListener("click", jumpToStart);

    const skipEndButton = document.getElementById("skipEndButton");
    if (skipEndButton) skipEndButton.addEventListener("click", jumpToEnd);

    if (nextGameBtn) {
        nextGameBtn.addEventListener("click", () => goToLatestGame({ showGame }));
    }
    document.getElementById("loadMoreGames")?.addEventListener("click", () => {
        visibleGameLimit += GAME_BATCH_SIZE;
        buildGrid(state.games);
    });
    setupFilterListeners({
        onFiltersChanged: () => buildGrid(state.games, [], { resetLimit: true }),
    });
    setupFavourites({
        onChange: ({ playerToggle = false } = {}) => {
            if (playerToggle) {
                if (state.favouritesOnly) {
                    buildGrid(state.games, [], { resetLimit: true });
                    return;
                }
                const gamesById = new Map(state.games.map((game) => [String(game.id), game]));
                document.querySelectorAll("#gamesGrid .game-tile[data-game-id]").forEach((tile) => {
                    const game = gamesById.get(tile.dataset.gameId);
                    tile.classList.toggle("has-favourite", Boolean(game && gameHasFollowedPlayer(game)));
                });
                return;
            }
            buildGrid(state.games, [], { resetLimit: true });
        },
    });

    setupKeyboardControls({
        onTogglePlay: clickPlayButton,
        onJumpToStart: jumpToStart,
        onJumpToEnd: jumpToEnd,
        onPreviousGame: () => loadAdjacentGame(1),
        onNextGame: () => loadAdjacentGame(-1),
        onSpeedUp: () => stepPlaybackRate(1, { speeds: SPEED_OPTIONS }),
        onSpeedDown: () => stepPlaybackRate(-1, { speeds: SPEED_OPTIONS }),
        onLatestGame: () => goToLatestGame({ showGame }),
        onToggleFollowLive: () => {
            const viewingLatestGame = gameHeader?.style.display !== "none" &&
                state.selectedGame?.id === state.latestGame?.id;
            if (!viewingLatestGame && !goToLatestGame({ showGame })) return false;
            setFollowLiveGames(!state.followLiveGames);
            if (followLiveCheckbox) followLiveCheckbox.checked = state.followLiveGames;
            return true;
        },
        onClearFilters: () => document.getElementById("clearFiltersButton")?.click(),
        onClearSelections: () => {
            state.selectedPlayers = new Set();
            state.hiddenTeams = null;
            applySelectedTileState();
        },
        onWiggleWorm: wiggleLogos,
        onShareGame: () => {
            if (shareButton) shareCurrentPage(shareButton);
        },
        onToggleComparisonDetails: () => {
            const toggle = document.getElementById("comparisonDetailsToggle");
            if (toggle && !toggle.hidden) toggle.click();
        },
        onToggleSplitTimelines: () => {
            const control = document.getElementById("splitWormControl");
            const toggle = document.getElementById("splitWormToggle");
            if (control && !control.hidden && toggle) toggle.click();
        },
        onShowHome: showHome,
    });
}
