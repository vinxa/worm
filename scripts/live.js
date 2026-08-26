import { WS_URL } from "./config.js";
import { state } from "./state.js";
import { normaliseGamePlayerIdentity } from "./playerIdentity.js";
import { liveEventIdentity } from "./liveRenderBuffer.js";
import { withLocalStorage } from "./browserStorage.js";
import { isPastScheduledGameLiveDeadline } from "./utils.js";

let ws;
let replaying = false;
let handlers = {};
let pendingActions = [];
let replayWatchdog = null;
const LIVE_ACTIONS = new Set(["event", "endGame", "finaliseGame", "broadcastGameData", "newGame"]);
const SNAPSHOT_ACTIONS = new Set(["finaliseGame", "broadcastGameData", "newGame"]);
const REPLAY_STALL_MS = 15000;
const FOLLOW_LIVE_GAMES_STORAGE_KEY = "worm:follow-live-games";
let liveSnapshotSeqNo = -1;
let currentGameSeqNo = -1;
let finalisedGameKey = null;
let replayStarted = false;
let replayRequestedGameKey = null;
let replayGameKey = null;
let replayToSeqNo = null;
let replayCanCompleteWithoutStart = true;
let pendingReplayLiveMessages = [];
let listedLiveGameKey = null;
let liveListSeqNo = -1;
let liveListSeenOnSocket = false;

export function setFollowLiveGames(enabled) {
    state.followLiveGames = Boolean(enabled);
    withLocalStorage((storage) =>
        storage.setItem(FOLLOW_LIVE_GAMES_STORAGE_KEY, String(state.followLiveGames))
    );
}

export function isSelectedCurrentLiveGame(game, liveGameKey) {
    if (!game) return false;
    if (isPastScheduledGameLiveDeadline(game)) return false;
    if (game.live === false && game.dataPath) return false;
    if (game.gameKey && liveGameKey) return game.gameKey === liveGameKey;
    return game.live === true;
}

export function isLiveGameSelected() {
    if (isPastScheduledGameLiveDeadline(state.selectedGame)) return false;
    return state.livePlaybackLocked ||
        isSelectedCurrentLiveGame(state.selectedGame, state.liveGameKey);
}

state.followLiveGames = withLocalStorage(
    (storage) => storage.getItem(FOLLOW_LIVE_GAMES_STORAGE_KEY) === "true",
    false,
);

function mergeEvents(...lists) {
    const merged = [];
    const seen = new Set();
    lists.flatMap((list) => Array.isArray(list) ? list : []).forEach((event) => {
        if (!event) return;
        const key = liveEventIdentity(event);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(event);
    });
    return merged;
}

export function setLiveHandlers(nextHandlers) {
    handlers = nextHandlers || {};
}

function send(action) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action }));
    else pendingActions.push(action);
}

function clearReplayWatchdog() {
    if (replayWatchdog !== null) clearTimeout(replayWatchdog);
    replayWatchdog = null;
}

function resetReplayTracking({ clearPending = true } = {}) {
    replaying = false;
    replayStarted = false;
    replayRequestedGameKey = null;
    replayGameKey = null;
    replayToSeqNo = null;
    replayCanCompleteWithoutStart = true;
    if (clearPending) pendingReplayLiveMessages = [];
}

function armReplayWatchdog() {
    clearReplayWatchdog();
    replayWatchdog = setTimeout(() => {
        replayWatchdog = null;
        if (!replaying) return;
        const stalledSocket = ws;
        resetReplayTracking();
        console.warn("Live replay stalled; requesting a fresh replay");
        if (state.liveGameData) handlers.onUpdate?.(state.liveGameData, { action: "replayStalled" });
        if (!state.liveSubscribed) return;
        // A replay attempt has no server-echoed nonce. Reconnect on a stall so
        // delayed envelopes from the abandoned attempt cannot complete or
        // overwrite the replacement replay on the same connection.
        if (stalledSocket?.readyState === WebSocket.OPEN &&
            typeof stalledSocket.close === "function") {
            stalledSocket.close();
        } else {
            beginReplay({ canCompleteWithoutStart: false });
        }
    }, REPLAY_STALL_MS);
}

function beginReplay({ canCompleteWithoutStart = true } = {}) {
    replaying = true;
    replayStarted = false;
    replayRequestedGameKey = state.liveGameKey;
    replayGameKey = null;
    replayToSeqNo = null;
    replayCanCompleteWithoutStart = canCompleteWithoutStart;
    pendingReplayLiveMessages = [];
    armReplayWatchdog();
    send("subscribe");
}

function resetLiveGameTracking(gameKey = null) {
    clearReplayWatchdog();
    resetReplayTracking();
    liveSnapshotSeqNo = -1;
    currentGameSeqNo = -1;
    state.liveGameKey = gameKey;
    state.liveGameData = null;
    state.liveSeqNo = -1;
    if (gameKey && isOlderGameKey(finalisedGameKey, gameKey)) finalisedGameKey = null;
}

export function subscribeToLiveGame(gameKey = state.liveGameKey) {
    const nextGameKey = gameKey || state.liveGameKey;
    if (nextGameKey && nextGameKey === finalisedGameKey) {
        state.liveSubscribed = false;
        return;
    }
    const supersedingReplay = Boolean(
        replaying && nextGameKey && nextGameKey !== state.liveGameKey
    );
    if (nextGameKey && nextGameKey !== state.liveGameKey) {
        resetLiveGameTracking(nextGameKey);
    } else if (nextGameKey) {
        state.liveGameKey = nextGameKey;
    }
    state.liveSubscribed = true;
    if (replaying) return;
    beginReplay({ canCompleteWithoutStart: !supersedingReplay });
}

export function unsubscribeFromLiveGame() {
    if (state.liveSubscribed) send("unsubscribe");
    state.liveSubscribed = false;
    resetLiveGameTracking();
}

export function clearLiveSubscriptionAfterFinalise(finalisedKey = null) {
    if (finalisedKey && state.liveGameKey && state.liveGameKey !== finalisedKey) {
        return;
    }
    state.liveSubscribed = false;
    resetLiveGameTracking();
}

function messageSequence(value) {
    if (value === null || value === undefined || value === "") return null;
    const sequence = Number(value);
    return Number.isFinite(sequence) ? sequence : null;
}

function messageGameKey(message) {
    const data = message?.data;
    return message?.gameKey || data?.gameKey || data?.game?.gameKey || null;
}

function isOlderGameKey(candidate, current) {
    return Boolean(candidate && current && String(candidate) < String(current));
}

function acceptMessageGameKey(gameKey) {
    if (!gameKey) return true;
    const currentGameKey = state.liveGameKey || state.liveGameData?.gameKey || null;
    if (gameKey === currentGameKey) return true;
    if (isOlderGameKey(gameKey, currentGameKey)) return false;
    state.liveGameKey = gameKey;
    state.liveGameData = null;
    state.liveSeqNo = -1;
    liveSnapshotSeqNo = -1;
    currentGameSeqNo = -1;
    if (isOlderGameKey(finalisedGameKey, gameKey)) finalisedGameKey = null;
    return true;
}

function applyLiveMessage(message) {
    const { action } = message;
    const data = normaliseGamePlayerIdentity(message.data);
    if (["newGame", "broadcastGameData", "finaliseGame"].includes(action)) {
        const currentGameKey = state.liveGameData?.gameKey || state.liveGameKey;
        const sameGame = currentGameKey && currentGameKey === data?.gameKey;
        const incomingPlayers = data?.players || {};
        const incomingTeams = Array.isArray(data?.teams) ? data.teams : [];
        const incomingBases = Array.isArray(data?.active_bases) ? data.active_bases : [];
        const structuralCandidates = [state.liveGameData, state.gameData]
            .filter((game) => game?.gameKey === data?.gameKey)
            .sort((left, right) =>
                Object.keys(right?.players || {}).length - Object.keys(left?.players || {}).length ||
                (right?.teams || []).length - (left?.teams || []).length ||
                (right?.active_bases || []).length - (left?.active_bases || []).length
            );
        const structuralSource = structuralCandidates[0] || null;
        // finaliseGame is deliberately a compact completion summary, not an
        // authoritative structural snapshot. Keep the richest matching roster
        // already assembled or displayed until the completed S3 file loads.
        const preserveFinaliseStructure = action === "finaliseGame" && sameGame &&
            structuralSource;
        state.liveGameData = {
            ...(sameGame ? state.liveGameData : {}),
            ...data,
            gameKey: data?.gameKey || currentGameKey,
            players: preserveFinaliseStructure
                ? structuralSource.players || {}
                : incomingPlayers,
            teams: preserveFinaliseStructure
                ? structuralSource.teams || []
                : incomingTeams,
            active_bases: preserveFinaliseStructure
                ? structuralSource.active_bases || []
                : incomingBases,
            events: sameGame
                ? mergeEvents(structuralSource?.events, state.liveGameData?.events, data?.events)
                : mergeEvents(data?.events),
        };
    } else {
        const events = Array.isArray(data) ? data : [data];
        const displayedLiveGame = state.gameData?.gameKey === state.liveGameKey
            ? state.gameData
            : null;
        const storedLiveGame = state.liveGameData?.gameKey === state.liveGameKey
            ? state.liveGameData
            : null;
        const storedPlayers = Object.keys(storedLiveGame?.players || {}).length
            ? storedLiveGame.players
            : displayedLiveGame?.players || {};
        const storedTeams = Array.isArray(storedLiveGame?.teams) && storedLiveGame.teams.length
            ? storedLiveGame.teams
            : displayedLiveGame?.teams || [];
        const storedBases = Array.isArray(storedLiveGame?.active_bases) && storedLiveGame.active_bases.length
            ? storedLiveGame.active_bases
            : displayedLiveGame?.active_bases || [];
        const baseGame = {
            ...(displayedLiveGame || {}),
            ...(storedLiveGame || {}),
            players: storedPlayers,
            teams: storedTeams,
            active_bases: storedBases,
        };
        const nextEvents = mergeEvents(baseGame.events, events);
        state.liveGameData = {
            ...baseGame,
            gameKey: baseGame.gameKey || state.liveGameKey,
            events: nextEvents,
            gameDuration: Math.max(
                Number(baseGame.gameDuration) || 0,
                ...nextEvents.map((event) => Number(event.time) || 0),
            ),
        };
    }
    state.liveGameKey = state.liveGameData?.gameKey || state.liveGameKey;
    if (!replaying && action !== "finaliseGame" && state.liveGameData) handlers.onUpdate?.(state.liveGameData, message);
}

function dispatchLiveMessage(message) {
    const gameKey = messageGameKey(message);
    if (!acceptMessageGameKey(gameKey)) return false;

    const seqNo = messageSequence(message.seqNo);
    if (seqNo !== null) {
        // API Gateway can deliver concurrent live Lambda broadcasts out of
        // order. Event deltas have their own identity and must not advance the
        // snapshot watermark: a slightly older structural snapshot may be the
        // message that introduces a newly joined player or team. Apply this
        // guard to replay snapshots too, so replay cannot regress live state.
        if (SNAPSHOT_ACTIONS.has(message.action)) {
            if (seqNo <= liveSnapshotSeqNo) return false;
            liveSnapshotSeqNo = seqNo;
        }
        state.liveSeqNo = Math.max(state.liveSeqNo, seqNo);
    }

    applyLiveMessage(message);
    if (message.action === "newGame") handlers.onNewGame?.(state.liveGameData, message);
    if (message.action === "finaliseGame") {
        // The Lambda has already removed every live connection. End the
        // client's subscription intent immediately, but retain the assembled
        // game until the presentation delay completes in main.js.
        finalisedGameKey = gameKey || state.liveGameKey;
        state.liveSubscribed = false;
        handlers.onFinalise?.(state.liveGameData, message);
    }
    return true;
}

function dispatchCurrentGame(message) {
    // A bounded replay is authoritative and has an exact sequence boundary.
    // The separate CURRENT response can contain structurally older data.
    if (replaying) return;
    const data = message.data || null;
    if (!data?.game || !acceptMessageGameKey(messageGameKey(message))) return;

    // Events advance CURRENT.seqNo without replacing CURRENT.data. Use the
    // compact game only as a fallback until an actual sequenced snapshot has
    // arrived, and only give it a structural watermark when CURRENT.action
    // proves that the envelope sequence belongs to a snapshot.
    const seqNo = messageSequence(message.seqNo);
    if (liveSnapshotSeqNo >= 0 ||
        (seqNo !== null && seqNo < currentGameSeqNo)) return;
    applyLiveMessage({
        action: data.action === "finaliseGame" ? "finaliseGame" : "broadcastGameData",
        data: data.game,
        seqNo: message.seqNo,
    });
    if (seqNo !== null) {
        currentGameSeqNo = seqNo;
        if (SNAPSHOT_ACTIONS.has(data.action)) liveSnapshotSeqNo = seqNo;
    }
    if (data.action === "finaliseGame") {
        // CURRENT can briefly expose the terminal item between the Lambda's
        // store and delete. Remember that fence so a stale live-index click
        // cannot re-subscribe to the already completed game.
        finalisedGameKey = messageGameKey(message) || state.liveGameKey;
        state.liveSubscribed = false;
    }
}

function dispatchReplayStart(message) {
    if (!replaying) return;
    const data = message.data;
    const gameKey = data?.gameKey || null;
    const seqNo = messageSequence(message.seqNo);
    const toSeqNo = messageSequence(data?.toSeqNo);
    if (!gameKey || seqNo === null || toSeqNo !== seqNo) return;
    if (isOlderGameKey(gameKey, replayRequestedGameKey) ||
        isOlderGameKey(gameKey, state.liveGameKey)) return;
    if (replayStarted && (
        isOlderGameKey(gameKey, replayGameKey) ||
        (gameKey === replayGameKey && seqNo < replayToSeqNo)
    )) return;
    if (!acceptMessageGameKey(gameKey)) return;

    replayStarted = true;
    replayGameKey = gameKey;
    replayToSeqNo = seqNo;
    replayLastSeqNo = -1;
    replayCanCompleteWithoutStart = false;
    armReplayWatchdog();
}

function dispatchReplayBatch(message) {
    if (!replaying || !replayStarted) return;
    const data = message.data;
    const seqNo = messageSequence(message.seqNo);
    if (!data || data.gameKey !== replayGameKey || seqNo !== replayToSeqNo ||
        !Array.isArray(data.messages)) return;

    armReplayWatchdog();
    data.messages.forEach((replayMessage) => {
        const replaySeqNo = messageSequence(replayMessage?.seqNo);
        if (!LIVE_ACTIONS.has(replayMessage?.action) ||
            messageGameKey(replayMessage) !== replayGameKey ||
            replaySeqNo === null || replaySeqNo > replayToSeqNo ||
            replaySeqNo < replayLastSeqNo) return;
        replayLastSeqNo = replaySeqNo;
        dispatchLiveMessage(replayMessage);
    });
}

function completeReplay(message) {
    const queuedMessages = pendingReplayLiveMessages;
    clearReplayWatchdog();
    resetReplayTracking();
    queuedMessages.forEach((queuedMessage) => dispatch(queuedMessage));
    if (state.liveGameData) handlers.onUpdate?.(state.liveGameData, message);
}

function dispatchReplayComplete(message) {
    if (!replaying) return;
    const data = message.data;
    const seqNo = messageSequence(message.seqNo);
    if (data === null) {
        // This is the Lambda's exact no-current-game response. It can only end
        // an attempt that has not accepted a keyed replayStart. A superseded
        // same-socket attempt is deliberately not allowed to complete this way.
        if (!replayStarted && replayCanCompleteWithoutStart && seqNo === 0) {
            completeReplay(message);
        }
        return;
    }
    const toSeqNo = messageSequence(data?.toSeqNo);
    if (!replayStarted || data?.gameKey !== replayGameKey ||
        seqNo !== replayToSeqNo || toSeqNo !== replayToSeqNo) return;
    state.liveSeqNo = Math.max(state.liveSeqNo, seqNo);
    completeReplay(message);
}

function dispatch(message) {
    if (!message || typeof message !== "object") return;
    if (message.action === "currentGame" || message.action === "currentGameState") {
        dispatchCurrentGame(message);
        return;
    }
    if (message.action === "replayStart") {
        dispatchReplayStart(message);
        return;
    }
    if (message.action === "replayBatch") {
        dispatchReplayBatch(message);
        return;
    }
    if (message.action === "replayComplete") {
        dispatchReplayComplete(message);
        return;
    }
    if (!LIVE_ACTIONS.has(message.action)) return;

    if (replaying) {
        const gameKey = messageGameKey(message);
        const expectedGameKey = replayGameKey || replayRequestedGameKey || state.liveGameKey;
        if (isOlderGameKey(gameKey, expectedGameKey)) return;
        // Finalisation is a terminal fence and the server clears subscriptions
        // immediately after broadcasting it. Apply it now so a replay stall or
        // reconnect cannot lose the client's logical unsubscribe. Its snapshot
        // sequence also prevents older replay snapshots from regressing it.
        if (message.action === "finaliseGame") {
            dispatchLiveMessage(message);
            return;
        }
        pendingReplayLiveMessages.push(message);
        return;
    }
    dispatchLiveMessage(message);
}

function connect() {
    const socket = new WebSocket(WS_URL);
    ws = socket;
    socket.onopen = () => {
        if (ws !== socket) return;
        send("getCurrentGame");
        const queued = pendingActions.splice(0)
            .filter((action) => action !== "subscribe" && action !== "unsubscribe");
        queued.forEach((action) => send(action));
        if (state.liveSubscribed) beginReplay();
    };
    socket.onmessage = (event) => {
        if (ws !== socket) return;
        try { dispatch(JSON.parse(event.data)); }
        catch (error) { console.error("Invalid live websocket message", error); }
    };
    socket.onerror = (error) => {
        if (ws === socket) console.error("Live websocket error", error);
    };
    socket.onclose = () => {
        if (ws !== socket) return;
        clearReplayWatchdog();
        resetReplayTracking();
        ws = null;
        setTimeout(connect, 2000);
    };
}

connect();
