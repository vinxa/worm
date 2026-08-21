import { state } from "./state.js";
import {
    showHome,
    showGame,
    buildGrid,
    initUI,
    renderGameData,
    showGamesIndexRetrying,
    updateNextGameButtonVisibility,
    wiggleLogos,
} from "./ui.js";
import {
    parseGameStart,
    initTeamScores,
    getGameDuration,
    getLivePresentationTime,
    isPastScheduledGameLiveDeadline,
    markGameNonLiveAfterDeadline,
    normaliseText,
} from "./utils.js";
import {
    clearLiveSubscriptionAfterFinalise,
    isLiveGameSelected,
    isSelectedCurrentLiveGame,
    setLiveHandlers,
    shouldFollowNewLiveGame,
} from "./live.js";
import { refreshLiveChartData } from "./timeline.js";
import { clearTimeouts, playReplay, seekToTime, setPlaybackRate, updatePlayButtonsLabel, updateResumeLiveButtons, updateSpeedButtons } from "./replayHandler.js";
import { getGameIdFromUrl, getViewStateFromUrl } from "./routing.js";
import { isBaseRunGame, normaliseBaseForOwningTeam } from "./baseRun.js";
import { animateLiveBaseEvents, animateLiveLifeEvents, animateLiveShotEvents, updatePlayerTiles } from "./playerTiles.js";
import { closeYouTubeModal, loadYouTubeUrl } from "./video.js";
import { normaliseGamePlayerIdentity } from "./playerIdentity.js";
import { applyInitialEventFilter } from "./filterSession.js";
import {
    compactLiveRenderData,
    insertPendingLiveRender,
    mergeReadyLiveRenderData,
    splitLiveRenderEvents,
    takeUnseenLiveEvents,
} from "./liveRenderBuffer.js";
import { LIVE_PRESENTATION_DELAY_CHANGE_EVENT } from "./liveDelay.js";
import { isAtLiveEdge, resolveLivePlayheadTime } from "./livePlayhead.js";

let uiReady = false;
let pendingLiveRenders = [];
let liveRenderTimer = null;
let liveRenderTimerReadyAt = null;
let liveRenderOrder = 0;
let bufferedLiveGameKey = null;
const bufferedLiveEventKeys = new Set();
let liveFinaliseTimer = null;
let pendingLiveFinalise = null;
const LEAGUE_LASERFORCE_GREEN = "#008140";

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

function normaliseLeagueLaserforceYellow(subject, name) {
    const isYellow = normaliseText(subject?.color) === "#ffff00" ||
        [subject?.name, subject?.colorName].some((value) =>
            /\byellow\b/i.test(String(value || ""))
        );
    return isYellow
        ? { ...subject, name, color: LEAGUE_LASERFORCE_GREEN, colorName: "Green" }
        : subject;
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
    const gameType = identifiedGameData?.gameType ||
        state.selectedGame?.gameType || state.selectedGame?.title || "";
    const isLeagueLaserforce = normaliseText(gameType).startsWith("league laserforce");
    const rawTeams = toTeamArray(identifiedGameData?.teams).map((team) => {
        const normalisedTeam = {
            ...team,
            id: String(team?.id ?? ""),
        };
        return isLeagueLaserforce
            ? normaliseLeagueLaserforceYellow(normalisedTeam, "Green Team")
            : normalisedTeam;
    });
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
            const normalisedBase = {
                entityId: String(base?.entityId || `legacy-base:${team || index}:${index}`),
                name: base?.name || "",
                team,
                color: base?.color || "",
                colorName: base?.colorName || "",
            };
            const presentationBase = isLeagueLaserforce
                ? normaliseLeagueLaserforceYellow(normalisedBase, "Green Base")
                : normalisedBase;
            return normaliseBaseForOwningTeam(presentationBase, rawTeams);
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
    bufferedLiveGameKey = null;
    bufferedLiveEventKeys.clear();
}

function cancelPendingLiveFinalise() {
    if (liveFinaliseTimer !== null) clearTimeout(liveFinaliseTimer);
    liveFinaliseTimer = null;
    pendingLiveFinalise = null;
}

function completePendingLiveFinalise() {
    liveFinaliseTimer = null;
    const pending = pendingLiveFinalise;
    if (!pending || state.liveGameKey !== pending.gameKey ||
        (state.selectedGame?.gameKey && state.selectedGame.gameKey !== pending.gameKey)) {
        pendingLiveFinalise = null;
        return;
    }
    const completionDuration = getGameDuration(pending.data) ||
        getGameDuration(state.gameData);
    if (!state.livePlayheadFollowing &&
        state.currentTime < completionDuration - 0.01) {
        liveFinaliseTimer = setTimeout(completePendingLiveFinalise, 250);
        return;
    }
    pendingLiveFinalise = null;
    const { data } = pending;
    cancelPendingLiveRender();
    state.selectedGame = {
        ...(state.selectedGame || {}),
        live: false,
        title: data.title || state.selectedGame?.title,
        dataPath: data.dataPath || state.selectedGame?.dataPath,
    };
    clearLiveSubscriptionAfterFinalise();
    updateNextGameButtonVisibility(false, false);
    loadGameData(data.dataPath || "", {
        prefetchedData: data.dataPath ? null : data,
        showSpinner: false,
    });
    fetchGamesIndex(true);
}

function schedulePendingLiveFinalise() {
    if (liveFinaliseTimer !== null) clearTimeout(liveFinaliseTimer);
    liveFinaliseTimer = null;
    if (!pendingLiveFinalise) return;
    const remainingPresentationSeconds = Math.max(
        0,
        getGameDuration(pendingLiveFinalise.data) -
            getLivePresentationTime(pendingLiveFinalise.data, state.selectedGame),
    );
    liveFinaliseTimer = setTimeout(
        completePendingLiveFinalise,
        remainingPresentationSeconds * 1000,
    );
}

function animatePendingLiveEffects(events) {
    if (!events.length) return;
    animateLiveShotEvents(events);
    animateLiveBaseEvents(events);
    animateLiveLifeEvents(events);
}

function schedulePendingLiveRender() {
    if (!pendingLiveRenders.length) return;
    const readyAt = pendingLiveRenders[0].readyAt;
    if (liveRenderTimer !== null && liveRenderTimerReadyAt <= readyAt) return;
    if (liveRenderTimer !== null) clearTimeout(liveRenderTimer);
    const delay = Math.max(0, readyAt - Date.now());
    liveRenderTimerReadyAt = readyAt;
    liveRenderTimer = setTimeout(() => {
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
            data: mergeReadyLiveRenderData(state.gameData, latest.data, ready),
            effectEvents: ready.flatMap((update) => update.effectEvents),
        };
        if (!isLiveGameSelected()) {
            cancelPendingLiveRender();
            return;
        }
        schedulePendingLiveRender();

        const data = pending.data;
        if (!data || data.gameKey !== pending.gameKey) return;

        const nextTeams = teamsWithPlayers(data.teams, data.players);
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
                followLivePlayhead: state.livePlayheadFollowing,
                liveReplayPlaying: state.isPlaying,
            }).then(() => {
                if (isLiveGameSelected() && state.livePlayheadFollowing &&
                    state.gameData?.gameKey === pending.gameKey) {
                    animatePendingLiveEffects(pending.effectEvents);
                }
            });
            return;
        }

        const wasFollowingLive = state.livePlayheadFollowing;
        const replayWasPlaying = state.isPlaying;
        const liveClockRunning = wasFollowingLive && replayWasPlaying &&
            state.replayAnimationFrame !== null;
        state.livePlaybackLocked = true;
        if (wasFollowingLive) setPlaybackRate(1, { force: true, restart: false });
        prepareGameData(data);
        state.currentTime = resolveLivePlayheadTime({
            currentTime: state.currentTime,
            presentationTime: getLivePresentationTime(state.gameData, state.selectedGame),
            duration: getGameDuration(state.gameData),
            following: wasFollowingLive,
        });
        const chartUpdated = refreshLiveChartData(state.gameData, state.currentTime);
        if (!chartUpdated) renderGameData();
        else seekToTime(state.currentTime, true);
        if (wasFollowingLive) {
            if (!liveClockRunning || !chartUpdated) startPlayback({ keepLive: true });
            animatePendingLiveEffects(pending.effectEvents);
        } else if (replayWasPlaying) {
            startPlayback();
        }
        updateResumeLiveButtons();
    }, delay);
}

window.addEventListener(
    LIVE_PRESENTATION_DELAY_CHANGE_EVENT,
    () => {
        if (liveRenderTimer !== null) clearTimeout(liveRenderTimer);
        liveRenderTimer = null;
        liveRenderTimerReadyAt = null;

        const referenceData = state.liveGameData || state.gameData || state.selectedGame;
        const presentationTime = getLivePresentationTime(referenceData, state.selectedGame);
        const now = Date.now();
        pendingLiveRenders.forEach((update) => {
            update.readyAt = now + Math.max(
                0,
                update.latestEventTime - presentationTime,
            ) * 1000;
        });
        pendingLiveRenders.sort((left, right) =>
            left.readyAt - right.readyAt || left.order - right.order
        );
        schedulePendingLiveRender();
        schedulePendingLiveFinalise();
    },
);

setLiveHandlers({
    onUpdate: (data, message) => {
        state.liveGameKey = data.gameKey || state.liveGameKey;
        if (!isLiveGameSelected()) return;
        const gameKey = data.gameKey || state.liveGameKey;
        if (!gameKey) return;

        const startingBuffer = bufferedLiveGameKey !== gameKey;
        if (bufferedLiveGameKey && bufferedLiveGameKey !== gameKey) {
            cancelPendingLiveRender();
        }
        bufferedLiveGameKey = gameKey;

        if (startingBuffer && state.gameData?.gameKey === gameKey) {
            takeUnseenLiveEvents(state.gameData.events, bufferedLiveEventKeys);
        }

        const incomingEffectEvents = message?.action === "event"
            ? (Array.isArray(message.data) ? message.data : [message.data]).filter(Boolean)
            : [];
        const candidateEvents = incomingEffectEvents.length
            ? incomingEffectEvents
            : (Array.isArray(data.events) ? data.events : []);
        const updateEvents = takeUnseenLiveEvents(candidateEvents, bufferedLiveEventKeys);
        const latestEventTime = candidateEvents.reduce(
            (latest, event) => Math.max(latest, Number(event?.time) || 0),
            0,
        );
        const presentationTime = getLivePresentationTime(data, state.selectedGame);
        const queuedAt = Date.now();
        splitLiveRenderEvents(updateEvents, incomingEffectEvents, latestEventTime)
            .forEach((update) => {
                insertPendingLiveRender(pendingLiveRenders, {
                    gameKey,
                    data: compactLiveRenderData(data, update.events),
                    effectEvents: update.effectEvents,
                    latestEventTime: update.latestEventTime,
                    order: ++liveRenderOrder,
                    readyAt: queuedAt + Math.max(
                        0,
                        update.latestEventTime - presentationTime,
                    ) * 1000,
                });
            });
        schedulePendingLiveRender();
    },
    onNewGame: (data) => {
        cancelPendingLiveFinalise();
        state.liveGameKey = data?.gameKey || state.liveGameKey;
        fetchGamesIndex(true);
    },
    onFinalise: (data) => {
        cancelPendingLiveFinalise();
        const gameKey = data?.gameKey || state.liveGameKey;
        pendingLiveFinalise = { data, gameKey };
        schedulePendingLiveFinalise();
    },
});

function expireOverdueLiveGames(now = Date.now()) {
    let indexChanged = false;
    const markedGames = state.games.map((game) => {
        const marked = markGameNonLiveAfterDeadline(game, now);
        if (marked !== game) indexChanged = true;
        return marked;
    });
    const selectedNeedsExpiry = isPastScheduledGameLiveDeadline(state.selectedGame, now) && (
        state.selectedGame?.live === true ||
        state.livePlaybackLocked ||
        state.livePlayheadFollowing
    );
    if (!indexChanged && !selectedNeedsExpiry) return;
    if (indexChanged) state.games = markedGames;

    if (state.latestGame) {
        state.latestGame = state.games.find((game) =>
            game.gameKey
                ? game.gameKey === state.latestGame.gameKey
                : game.id === state.latestGame.id
        ) || markGameNonLiveAfterDeadline(state.latestGame, now);
    }

    if (selectedNeedsExpiry) {
        state.selectedGame = markGameNonLiveAfterDeadline(state.selectedGame, now);
        state.livePlaybackLocked = false;
        state.livePlayheadFollowing = false;
        state.isPlaying = false;
        clearTimeouts();
        updatePlayButtonsLabel("▶");
        updateResumeLiveButtons();
        updateSpeedButtons();
    }

    if (state.gamesIndexLoaded) buildGrid(state.games);
    updateNextGameButtonVisibility();
}

async function fetchConfig(path, label, apply) {
    try {
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) throw new Error(`Couldn't fetch ${label}`);
        apply(await response.json());
    } catch (err) {
        console.error(`Failed to load ${label}:`, err);
    }
}

async function fetchGamesIndex(fromPoll = false) {
    try {
        const res = await fetch(state.S3_BASE_URL + "/live/index.json", { cache: "no-cache" });
        if (!res.ok) throw new Error("Couldn't fetch games index");
        const list = await res.json();
        if (!Array.isArray(list)) throw new Error("Games index wasn't an array");
        const gamesByIdentity = new Map();
        list.forEach((game, index) => {
            if (!game || typeof game !== "object") return;
            const identity = String(game.gameKey || game.id || `index:${index}`);
            gamesByIdentity.set(identity, game);
        });
        const uniqueList = [...gamesByIdentity.values()]
            .map((game) => markGameNonLiveAfterDeadline(game));
        const previousIds = new Set(state.games.map((game) => game.id));
        const previousLatestId = state.latestGame?.id;
        const wasIndexLoaded = state.gamesIndexLoaded;

        state.games = uniqueList;
        state.gamesIndexLoaded = true;
        state.latestGame = uniqueList.length
            ? [...uniqueList].sort((a, b) => b.id.localeCompare(a.id))[0]
            : null;
        if (!wasIndexLoaded && uiReady) showViewFromUrl();
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
            isSelectedCurrentLiveGame(state.latestGame, state.liveGameKey);
        const start = parseGameStart(state.latestGame);
        const isFresh = start && Date.now() - start.getTime() <
            (state.latestGame.gameDuration || 15 * 60) * 1000;
        const completedIndexAvailable = Boolean(
            state.latestGame?.dataPath &&
            state.latestGame.dataPath !== state.selectedGame?.dataPath
        );
        if (viewingLatest && (isFresh || completedIndexAvailable) &&
            !viewingLiveLatest && !state.isGameLoading) {
            state.selectedGame = state.latestGame;
            loadGameData(state.latestGame.dataPath, {
                skipIfSignatureUnchanged: true,
                showSpinner: false,
            });
        }
    } catch (err) {
        console.error("Failed to refresh games index:", err);
        if (!state.gamesIndexLoaded) showGamesIndexRetrying();
    }
}

function showViewFromUrl() {
    const gameId = getGameIdFromUrl();
    if (!gameId) {
        showHome({ updateHistory: false });
        return;
    }

    const game = state.games.find((entry) =>
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
        followLivePlayhead = null,
        liveReplayPlaying = false,
        initialViewState = null,
    } = options;
    try {
        state.isGameLoading = true;
        if (showSpinner) {
            state.loadingStart = Date.now();
            document.getElementById("loading-indicator").style.display = "flex";
        }
        state.livePlaybackLocked = livePlayback;

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
        clearTimeouts();
        updatePlayButtonsLabel("▶");
        prepareGameData(data);
        const defaultTime = livePlayback
            ? getLivePresentationTime(state.gameData, state.selectedGame || data)
            : state.gameData.gameDuration;
        state.currentTime = initialViewState?.time === null || initialViewState?.time === undefined
            ? defaultTime
            : Math.min(getGameDuration(state.gameData), Math.max(0, initialViewState.time));
        const inferredLiveFollow = !initialViewState ||
            initialViewState.time === null || initialViewState.time === undefined ||
            isAtLiveEdge(state.currentTime, defaultTime);
        state.livePlayheadFollowing = livePlayback && (followLivePlayhead === null
            ? inferredLiveFollow
            : Boolean(followLivePlayhead));
        state.isPlaying = livePlayback &&
            (state.livePlayheadFollowing || Boolean(liveReplayPlaying));
        if (state.livePlayheadFollowing) {
            setPlaybackRate(1, { force: true, restart: false });
        } else {
            updateSpeedButtons();
        }
        updateResumeLiveButtons();

        if (initialViewState) {
            state.selectedPlayers = new Set(initialViewState.selectedPlayers || []);
            state.hiddenTeams = new Set(initialViewState.selectedTeams || []);
            state.splitWorm = Boolean(initialViewState.splitWorm);
            state.comparisonDetails = Boolean(initialViewState.comparisonDetails);
            state.deniesVisible = Boolean(initialViewState.deniesVisible);
            if (!livePlayback && initialViewState.playbackRate) {
                setPlaybackRate(initialViewState.playbackRate, { restart: false });
            }
        } else {
            state.hiddenTeams = null;
            state.splitWorm = false;
            state.comparisonDetails = true;
            state.deniesVisible = true;
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
        if (state.livePlayheadFollowing) startPlayback({ keepLive: true });
        else if (state.isPlaying) startPlayback();

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

fetchConfig("static/events/events.json", "events config", (list) => {
    state.events = Array.isArray(list) ? list : [];
    applyInitialEventFilter(state.events);
}).then(() => {
    if (state.games.length) buildGrid(state.games);
});
fetchConfig("static/config/reload-amounts.json", "reload replenishment config", (config) => {
    state.reloadReplenishment = config?.gameTypes && typeof config.gameTypes === "object"
        ? config.gameTypes
        : {};
}).then(() => {
    if (state.gameData) updatePlayerTiles(state.currentTime);
});
fetchGamesIndex(false);
setInterval(() => fetchGamesIndex(true), 15000);
setInterval(expireOverdueLiveGames, 250);

document.addEventListener("DOMContentLoaded", () => {
    initUI(loadGameData);
    uiReady = true;
    if (state.gamesIndexLoaded) {
        showViewFromUrl();
    } else {
        showHome({ unsubscribe: false, updateHistory: false, disableLiveFollow: false });
    }
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
