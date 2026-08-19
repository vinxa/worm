import { state } from "./state.js";
import { showHome, showGame, buildGrid, initUI, renderGameData, updateNextGameButtonVisibility, wiggleLogos } from "./ui.js";
import { parseGameStart, initTeamScores, getGameDuration, getLivePresentationTime, normaliseText } from "./utils.js";
import { isLiveGameSelected, setLiveHandlers, shouldFollowNewLiveGame } from "./live.js";
import { refreshLiveChartData } from "./timeline.js";
import { clearTimeouts, playReplay, seekToTime, setPlaybackRate, updatePlayButtonsLabel, updateSpeedButtons } from "./replayHandler.js";
import { getGameIdFromUrl, getViewStateFromUrl } from "./routing.js";
import { isBaseRunGame } from "./baseRun.js";
import { animateLiveBaseEvents, animateLiveShotEvents, updatePlayerTiles } from "./playerTiles.js";
import { closeYouTubeModal, loadYouTubeUrl } from "./video.js";
import { normaliseGamePlayerIdentity } from "./playerIdentity.js";
import { applyInitialEventFilter } from "./filterSession.js";

let uiReady = false;
let pendingLiveRenders = [];
let liveRenderTimer = null;
let liveRenderTimerReadyAt = null;
let liveRenderOrder = 0;
let liveFinaliseTimer = null;

function isInternalParserPayload(data) {
    if (!data || typeof data !== "object") return false;
    const hasObjectTeams = data.teams && !Array.isArray(data.teams);
    const hasObjectBases = data.active_bases && !Array.isArray(data.active_bases);
    const hasInternalBaseEvents = (Array.isArray(data.events) ? data.events : []).some(
        (event) => event?.type === "base-hit" || event?.type === "base-destroy"
    );
    return Boolean(hasObjectTeams || hasObjectBases || hasInternalBaseEvents);
}

function toTeamArray(teams) {
    return Array.isArray(teams)
        ? teams
        : Object.entries(teams || {}).map(([id, team]) => ({
            id,
            ...(team && typeof team === "object" ? team : {}),
        }));
}

function teamsWithPlayers(teams, players) {
    const playerTeamIds = new Set(
        Object.values(players || {})
            .map((player) => player?.team)
            .filter((teamId) => teamId !== undefined && teamId !== null && teamId !== "")
            .map(String)
    );
    return toTeamArray(teams).filter((team) => playerTeamIds.has(String(team.id)));
}

function prepareGameData(gameData) {
    const identifiedGameData = normaliseGamePlayerIdentity(gameData);
    const rawTeams = toTeamArray(identifiedGameData?.teams).map((team) => ({
        ...team,
        id: String(team?.id ?? ""),
    }));
    const rawPlayers = identifiedGameData?.players && !Array.isArray(identifiedGameData.players)
        ? identifiedGameData.players
        : {};
    const players = Object.fromEntries(
        Object.entries(rawPlayers).map(([playerId, player]) => {
            const id = String(player?.id ?? playerId);
            return [id, {
                ...(player || {}),
                id,
                team: String(player?.team ?? player?.teamId ?? ""),
            }];
        })
    );
    const rawEvents = (Array.isArray(identifiedGameData?.events) ? identifiedGameData.events : []).map((event) => ({
        ...event,
        entity: event?.entity == null ? event?.entity : String(event.entity),
        target: event?.target == null ? event?.target : String(event.target),
        time: Number(event?.time) || 0,
        delta: Number(event?.delta) || 0,
    }));
    const teams = teamsWithPlayers(rawTeams, players);
    const teamIds = new Set(teams.map((team) => normaliseText(team.id)));
    const allActiveBases = (Array.isArray(identifiedGameData?.active_bases) ? identifiedGameData.active_bases : [])
        .map((base, index) => {
            const team = String(base?.team ?? "");
            return {
                entityId: String(base?.entityId || `legacy-base:${team || index}:${index}`),
                name: base?.name || "",
                team,
                color: base?.color || "",
                colorName: base?.colorName || "",
            };
        });
    const baseByEntityId = new Map(
        allActiveBases
            .filter((base) => normaliseText(base.entityId))
            .map((base) => [normaliseText(base.entityId), base])
    );
    const basesByTeamId = new Map();
    allActiveBases.forEach((base) => {
        const teamId = normaliseText(base.team);
        if (!teamId) return;
        if (!basesByTeamId.has(teamId)) basesByTeamId.set(teamId, []);
        basesByTeamId.get(teamId).push(base);
    });
    const events = rawEvents.map((event) => {
        if (event?.type !== "base hit" && event?.type !== "base destroy") return event;
        const targetId = normaliseText(event.target);
        const matchingBases = basesByTeamId.get(targetId) || [];
        return targetId && !baseByEntityId.has(targetId) && matchingBases.length === 1
            ? { ...event, target: matchingBases[0].entityId }
            : event;
    });
    const eventBaseEntityIds = new Set(
        events
            .filter((event) => event?.type === "base hit" || event?.type === "base destroy")
            .map((event) => normaliseText(event.target))
            .filter(Boolean)
    );
    const preserveBaseRunBases = isBaseRunGame(identifiedGameData, state.selectedGame);
    const activeBases = allActiveBases
        .filter((base) => {
            const teamId = base?.team;
            const normalisedTeamId = normaliseText(teamId);
            // Some Base Run targets (for example Yellow) have no players of
            // their own. Legacy Base Run events may also have no target, so
            // preserve the explicit migrated base list for those games.
            return preserveBaseRunBases || teamIds.has(normalisedTeamId) ||
                eventBaseEntityIds.has(normaliseText(base?.entityId));
        });

    state.gameData = {
        ...(identifiedGameData || {}),
        teams,
        players,
        events,
        active_bases: activeBases,
    };
    state.playerEvents = state.gameData.events.reduce((byPlayer, event) => {
        (byPlayer[event.entity] ||= []).push(event);
        return byPlayer;
    }, {});
    Object.values(state.playerEvents).forEach((arr) =>
        arr.sort((a, b) => a.time - b.time)
    );

    const maxEvent = events.length
        ? Math.max(...events.map((e) => Number(e.time) || 0))
        : 0;
    const baseDuration = Number(state.gameData.gameDuration) || 0;
    state.gameData.gameDuration = Math.max(baseDuration, maxEvent);

    state.gameData.playerStats = {};
    Object.entries(state.gameData.players).forEach(([pid, info]) => {
        const playerEvents = state.playerEvents[pid] || [];
        const eventScore = playerEvents.reduce((sum, ev) => sum + (ev.delta || 0), 0);
        const snapshotScore = Number(info.score) || 0;
        const score = playerEvents.length ? eventScore : snapshotScore;
        state.gameData.playerStats[pid] = { name: info.name, score, finalScore: score };
    });

    state.teamScores = initTeamScores(state.gameData.teams);
}

function sameIds(previousValues = [], nextValues = []) {
    const previous = new Set(previousValues);
    const next = new Set(nextValues);
    return previous.size === next.size && [...next].every((id) => previous.has(id));
}

function startPlayback({ keepLive = false } = {}) {
    if (!state.chart || !state.gameData) return;
    if (getGameDuration(state.gameData) <= state.currentTime + 0.01) {
        if (!keepLive) {
            state.isPlaying = false;
            updatePlayButtonsLabel("▶");
        }
        return;
    }
    state.isPlaying = true;
    clearTimeouts();
    updatePlayButtonsLabel("❚❚");
    playReplay(
        state.chart,
        state.gameData,
        state.playbackRate,
        state.replayTimeouts,
        state.currentTime,
        { followLiveClock: keepLive },
    );
}

function cancelPendingLiveRender() {
    if (liveRenderTimer !== null) clearTimeout(liveRenderTimer);
    liveRenderTimer = null;
    liveRenderTimerReadyAt = null;
    pendingLiveRenders = [];
}

function cancelPendingLiveFinalise() {
    if (liveFinaliseTimer !== null) clearTimeout(liveFinaliseTimer);
    liveFinaliseTimer = null;
}

function animatePendingLiveEffects(events) {
    if (!events.length) return;
    animateLiveShotEvents(events);
    animateLiveBaseEvents(events);
}

function schedulePendingLiveRender() {
    if (!pendingLiveRenders.length) return;
    const readyAt = pendingLiveRenders[0].readyAt;
    if (liveRenderTimer !== null && liveRenderTimerReadyAt <= readyAt) return;
    if (liveRenderTimer !== null) clearTimeout(liveRenderTimer);
    const delay = Math.max(0, readyAt - Date.now());
    liveRenderTimerReadyAt = readyAt;
    liveRenderTimer = setTimeout(renderPendingLiveUpdate, delay);
}

function renderPendingLiveUpdate() {
    liveRenderTimer = null;
    liveRenderTimerReadyAt = null;
    const now = Date.now();
    let readyCount = 0;
    while (readyCount < pendingLiveRenders.length &&
        pendingLiveRenders[readyCount].readyAt <= now) {
        readyCount++;
    }
    if (!readyCount) {
        schedulePendingLiveRender();
        return;
    }

    const ready = pendingLiveRenders.splice(0, readyCount);
    const latest = ready.reduce((newest, update) =>
        update.order > newest.order ? update : newest
    );
    const pending = {
        gameKey: latest.gameKey,
        data: latest.data,
        effectEvents: ready.flatMap((update) => update.effectEvents),
    };
    if (!isLiveGameSelected()) {
        cancelPendingLiveRender();
        return;
    }
    schedulePendingLiveRender();

    const data = pending.data;
    if (!data || data.gameKey !== pending.gameKey) return;

    const nextTeams = teamsWithPlayers(data?.teams, data?.players);
    const sameStructure = state.gameData && state.gameData.gameKey === data.gameKey &&
        sameIds(
            (state.gameData.teams || []).map((team) => team.id),
            nextTeams.map((team) => team.id)
        ) &&
        sameIds(Object.keys(state.gameData.players || {}), Object.keys(data.players || {}));
    if (!state.chart || !sameStructure) {
        loadGameData("", {
            prefetchedData: data,
            showSpinner: false,
            livePlayback: true,
        }).then(() => {
            if (isLiveGameSelected() && state.gameData?.gameKey === pending.gameKey) {
                animatePendingLiveEffects(pending.effectEvents);
            }
        });
        return;
    }

    const liveClockRunning = state.isPlaying && state.replayAnimationFrame !== null;
    state.livePlaybackLocked = true;
    setPlaybackRate(1, { force: true, restart: false });
    prepareGameData(data);
    state.currentTime = Math.max(
        state.currentTime,
        getLivePresentationTime(state.gameData, state.selectedGame)
    );
    const chartUpdated = refreshLiveChartData(state.gameData, state.currentTime);
    if (!chartUpdated) renderGameData();
    else seekToTime(state.currentTime, true);
    if (!liveClockRunning || !chartUpdated) startPlayback({ keepLive: true });
    animatePendingLiveEffects(pending.effectEvents);
}

function queueLiveRender(data, message) {
    const gameKey = data?.gameKey || state.liveGameKey;
    if (!gameKey) return;

    if (pendingLiveRenders.length && pendingLiveRenders[0].gameKey !== gameKey) {
        cancelPendingLiveRender();
    }

    const effectEvents = message?.action === "event"
        ? (Array.isArray(message.data) ? message.data : [message.data]).filter(Boolean)
        : [];
    const updateEvents = effectEvents.length
        ? effectEvents
        : (Array.isArray(data?.events) ? data.events : []);
    const latestEventTime = Math.max(
        0,
        ...updateEvents.map((event) => Number(event?.time) || 0)
    );
    const presentationTime = getLivePresentationTime(data, state.selectedGame);
    pendingLiveRenders.push({
        gameKey,
        data,
        effectEvents,
        order: ++liveRenderOrder,
        readyAt: Date.now() + Math.max(0, latestEventTime - presentationTime) * 1000,
    });
    pendingLiveRenders.sort((left, right) => left.readyAt - right.readyAt);
    schedulePendingLiveRender();
}

setLiveHandlers({
    onUpdate: (data, message) => {
        state.liveGameKey = data.gameKey || state.liveGameKey;
        if (!isLiveGameSelected()) return;
        queueLiveRender(data, message);
    },
    onNewGame: (data) => {
        cancelPendingLiveFinalise();
        state.liveGameKey = data?.gameKey || state.liveGameKey;
        fetchGamesIndex(true);
    },
    onFinalise: (data) => {
        cancelPendingLiveFinalise();
        const gameKey = data?.gameKey || state.liveGameKey;
        const remainingPresentationSeconds = Math.max(
            0,
            getGameDuration(data) - getLivePresentationTime(data, state.selectedGame)
        );
        liveFinaliseTimer = setTimeout(() => {
            liveFinaliseTimer = null;
            if (!state.liveSubscribed ||
                (state.selectedGame?.gameKey && state.selectedGame.gameKey !== gameKey)) {
                return;
            }
            cancelPendingLiveRender();
            state.selectedGame = {
                ...(state.selectedGame || {}),
                live: false,
                title: data.title || state.selectedGame?.title,
                dataPath: data.dataPath || state.selectedGame?.dataPath,
            };
            state.liveGameKey = null;
            state.liveGameData = null;
            updateNextGameButtonVisibility(false, false);
            loadGameData(data.dataPath || "", { prefetchedData: data.dataPath ? null : data, showSpinner: false });
            fetchGamesIndex(true);
        }, remainingPresentationSeconds * 1000);
    },
});

async function fetchConfig(path, label, apply) {
    try {
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) throw new Error(`Couldn't fetch ${label}`);
        apply(await response.json());
        return true;
    } catch (err) {
        console.error(`Failed to load ${label}:`, err);
        return false;
    }
}

async function fetchGamesIndex(fromPoll = false) {
    try {
        const res = await fetch(state.S3_BASE_URL + "/live/index.json", { cache: "no-cache" });
        if (!res.ok) throw new Error("Couldn't fetch games index");
        const list = await res.json();
        if (!Array.isArray(list)) return;
        const gamesByIdentity = new Map();
        list.forEach((game, index) => {
            if (!game || typeof game !== "object") return;
            const identity = String(game.gameKey || game.id || `index:${index}`);
            gamesByIdentity.set(identity, game);
        });
        const uniqueList = [...gamesByIdentity.values()];
        const previousIds = new Set((state.games || []).map((game) => game.id));
        const previousLatestId = state.latestGame?.id;

        state.games = uniqueList;
        state.latestGame = uniqueList.length
            ? [...uniqueList].sort((a, b) => b.id.localeCompare(a.id))[0]
            : null;
        if (!fromPoll && uiReady) showViewFromUrl();
        buildGrid(uniqueList, fromPoll
            ? uniqueList.filter((game) => !previousIds.has(game.id)).map((game) => game.id)
            : []
        );

        const latestChanged = state.latestGame?.id && state.latestGame.id !== previousLatestId;
        updateNextGameButtonVisibility(fromPoll && latestChanged, fromPoll && latestChanged);

        if (shouldFollowNewLiveGame({
            enabled: state.followLiveGames,
            fromPoll,
            previousLatestId,
            latestGame: state.latestGame,
            selectedGame: state.selectedGame,
        })) {
            state.selectedPlayers = new Set();
            showGame(state.latestGame);
        }

        const viewingLatest = fromPoll && state.selectedGame && state.latestGame &&
            state.selectedGame.id === state.latestGame.id;
        const viewingLiveLatest = viewingLatest &&
            (state.latestGame.live === true || state.latestGame.gameKey === state.liveGameKey);
        const start = parseGameStart(state.latestGame);
        const isFresh = start && Date.now() - start.getTime() <
            (state.latestGame.gameDuration || 15 * 60) * 1000;
        if (viewingLatest && isFresh && !viewingLiveLatest && !state.isGameLoading) {
            loadGameData(state.latestGame.dataPath, {
                skipIfSignatureUnchanged: true,
                showSpinner: false,
            });
        }
    } catch (err) {
        console.error("Failed to refresh games index:", err);
    }
}

function showViewFromUrl() {
    const gameId = getGameIdFromUrl();
    if (!gameId) {
        showHome({ updateHistory: false });
        return;
    }

    const game = (state.games || []).find((entry) =>
        String(entry.id) === gameId || String(entry.gameKey || "") === gameId
    );
    if (!game) {
        console.warn(`Game not found in index: ${gameId}`);
        showHome({ updateHistory: false });
        return;
    }

    showGame(game, {
        updateHistory: false,
        viewState: getViewStateFromUrl(),
    });
}

export async function loadGameData(dataPath, options = {}) {
    const {
        skipIfSignatureUnchanged = false,
        showSpinner = true,
        prefetchedData = null,
        livePlayback = false,
        initialViewState = null,
    } = options;
    try {
        state.isGameLoading = true;
        if (showSpinner) {
            state.loadingStart = Date.now();
            document.getElementById("loading-indicator").style.display = "flex";
        }
        state.livePlaybackLocked = livePlayback;
        if (livePlayback) setPlaybackRate(1, { force: true, restart: false });
        else updateSpeedButtons();

        let data = prefetchedData;
        if (!data && dataPath) {
            const response = await fetch(dataPath, { cache: "no-store" });
            if (!response.ok) throw new Error(`Couldn't fetch game data (${response.status})`);
            data = await response.json();

            const fallbackPath = isInternalParserPayload(data) &&
                typeof dataPath === "string" && dataPath.includes("/live/games/")
                ? dataPath.replace("/live/games/", "/games/")
                : "";
            if (fallbackPath) {
                try {
                    const fallbackResponse = await fetch(fallbackPath, { cache: "no-store" });
                    if (fallbackResponse.ok) {
                        const fallbackData = await fallbackResponse.json();
                        if (!isInternalParserPayload(fallbackData)) {
                            console.warn(`Using preserved finalized game data for ${dataPath}`);
                            data = fallbackData;
                        }
                    }
                } catch (error) {
                    console.warn(`Unable to load preserved game data for ${dataPath}:`, error);
                }
            }
        }
        if (!data) return;

        const sigKey = state.selectedGame?.id || data.id || dataPath;
        const explicitVersion = data.lastUpdated || data.updatedAt || data.timestamp || data.generatedAt;
        let newSig = String(explicitVersion || "");
        if (!explicitVersion) {
            const signatureEvents = Array.isArray(data.events) ? data.events : [];
            const lastEvent = signatureEvents[signatureEvents.length - 1] || {};
            const teamIds = (Array.isArray(data.teams) ? data.teams : Object.keys(data.teams || {}))
                .map((team) => typeof team === "object" ? team.id : team)
                .sort()
                .join(",");
            newSig = [
                signatureEvents.length,
                lastEvent.time ?? "",
                lastEvent.delta ?? "",
                data.gameDuration ?? "",
                Object.keys(data.players || {}).sort().join(","),
                teamIds,
            ].join("|");
        }
        const prevSig = state.gameSignatures[sigKey];
        if (skipIfSignatureUnchanged && prevSig && prevSig === newSig) {
            return;
        }
        state.gameSignatures[sigKey] = newSig;
        state.isPlaying = livePlayback;
        clearTimeouts();
        updatePlayButtonsLabel("▶");
        prepareGameData(data);
        const defaultTime = livePlayback
            ? getLivePresentationTime(state.gameData, state.selectedGame || data)
            : state.gameData.gameDuration;
        state.currentTime = initialViewState?.time === null || initialViewState?.time === undefined
            ? defaultTime
            : Math.min(getGameDuration(state.gameData), Math.max(0, initialViewState.time));

        if (initialViewState) {
            state.selectedPlayers = new Set(initialViewState.selectedPlayers || []);
            state.hiddenTeams = new Set(initialViewState.selectedTeams || []);
            if (!livePlayback && initialViewState.playbackRate) {
                setPlaybackRate(initialViewState.playbackRate, { restart: false });
            }
        } else {
            state.hiddenTeams = null;
        }

        renderGameData();
        if (initialViewState) {
            const urlInput = document.getElementById("youtubeUrl");
            if (initialViewState.youtubeUrl) {
                loadYouTubeUrl(initialViewState.youtubeUrl);
            } else {
                if (urlInput) urlInput.value = "";
                closeYouTubeModal();
            }
        }
        if (livePlayback) startPlayback({ keepLive: true });

    } catch (err) {
        console.error("Failed to load game data:", err);
    } finally {
        state.isGameLoading = false;
        if (showSpinner) hideLoadingIndicator();
    }
}

function hideLoadingIndicator() {
    const elapsed = Date.now() - state.loadingStart;
    const minDisplay = 300;
    if (elapsed < minDisplay) {
        setTimeout(hideLoadingIndicator, minDisplay - elapsed);
        return;
    }
    document.getElementById('loading-indicator').style.display = 'none';
    wiggleLogos();
}

// Load list of games initially and start polling
fetchConfig("static/events/events.json", "events config", (list) => {
    state.events = Array.isArray(list) ? list : [];
    applyInitialEventFilter(state.events);
}).then((loaded) => {
    if (!loaded) state.events = [];
    if (state.games?.length) buildGrid(state.games);
});
fetchConfig("static/config/reload-amounts.json", "reload replenishment config", (config) => {
    state.reloadReplenishment = config?.gameTypes && typeof config.gameTypes === "object"
        ? config.gameTypes
        : {};
}).then((loaded) => {
    if (!loaded) state.reloadReplenishment = {};
    if (state.gameData) updatePlayerTiles(state.currentTime);
});
fetchGamesIndex(false);
setInterval(() => fetchGamesIndex(true), 15000);

document.addEventListener("DOMContentLoaded", () => {
    initUI(loadGameData);
    uiReady = true;
    showHome({ unsubscribe: false, updateHistory: false, disableLiveFollow: false });
    if (state.games.length) showViewFromUrl();
    window.addEventListener("popstate", showViewFromUrl);

    let deferredPrompt;
    const installButton = document.getElementById('installButton');

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        installButton.style.display = 'inline-flex';
    });

    installButton.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        installButton.style.display = 'none';
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        installButton.style.display = 'none';
    });
});
