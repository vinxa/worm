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
const REPLAY_STALL_MS = 15000;
const FOLLOW_LIVE_GAMES_STORAGE_KEY = "worm:follow-live-games";

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

export function shouldFollowNewLiveGame({
    enabled,
    fromPoll,
    previousLatestId,
    latestGame,
    selectedGame,
}) {
    return Boolean(
        enabled &&
        fromPoll &&
        previousLatestId &&
        latestGame?.id &&
        latestGame.id !== previousLatestId &&
        isSelectedCurrentLiveGame(latestGame, null) &&
        selectedGame?.id !== latestGame.id
    );
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

function armReplayWatchdog() {
    clearReplayWatchdog();
    replayWatchdog = setTimeout(() => {
        replayWatchdog = null;
        if (!replaying) return;
        replaying = false;
        console.warn("Live replay stalled; requesting a fresh replay");
        if (state.liveGameData) handlers.onUpdate?.(state.liveGameData, { action: "replayStalled" });
        if (state.liveSubscribed) beginReplay();
    }, REPLAY_STALL_MS);
}

function beginReplay() {
    replaying = true;
    armReplayWatchdog();
    send("subscribe");
}

export function subscribeToLiveGame() {
    state.liveSubscribed = true;
    beginReplay();
}

export function unsubscribeFromLiveGame() {
    if (state.liveSubscribed) send("unsubscribe");
    clearReplayWatchdog();
    replaying = false;
    state.liveSubscribed = false;
    state.liveGameKey = null;
    state.liveGameData = null;
    state.liveSeqNo = -1;
}

function applyLiveMessage(message) {
    const { action } = message;
    const data = normaliseGamePlayerIdentity(message.data);
    if (["newGame", "broadcastGameData", "finaliseGame"].includes(action)) {
        const currentGameKey = state.liveGameData?.gameKey || state.liveGameKey;
        const sameGame = currentGameKey && currentGameKey === data?.gameKey;
        state.liveGameData = {
            ...(sameGame ? state.liveGameData : {}),
            ...data,
            gameKey: data?.gameKey || currentGameKey,
            events: sameGame
                ? mergeEvents(state.liveGameData?.events, data?.events)
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

function dispatch(message, { fromReplay = false } = {}) {
    if (!message || typeof message !== "object") return;
    const data = message.data || null;
    const messageGameKey = message.gameKey || data?.gameKey || data?.game?.gameKey || null;
    const currentGameKey = state.liveGameData?.gameKey || state.liveGameKey;
    if (messageGameKey && messageGameKey !== currentGameKey) {
        state.liveGameData = null;
        state.liveGameKey = messageGameKey;
        state.liveSeqNo = -1;
    }

    const seqNo = Number(message.seqNo);
    if (!fromReplay && Number.isFinite(seqNo) && LIVE_ACTIONS.has(message.action)) {
        // API Gateway can deliver concurrent live Lambda broadcasts out of
        // order. Event messages are independently deduplicated by mergeEvents,
        // so a late event must still be applied even when a higher seqNo was
        // already received. Snapshot/finalisation messages remain ordered.
        const isEventDelta = message.action === "event" || message.action === "endGame";
        if (!isEventDelta && seqNo <= state.liveSeqNo) return;
        state.liveSeqNo = Math.max(state.liveSeqNo, seqNo);
    }

    if (message.action === "currentGame" || message.action === "currentGameState") {
        // CURRENT_GAME stores a compact snapshot with events omitted. Treat it
        // as a snapshot regardless of the last action that touched the game.
        if (data?.game) {
            applyLiveMessage({ action: "broadcastGameData", data: data.game, seqNo: message.seqNo });
        }
    } else if (message.action === "replayStart") {
        replaying = true;
        armReplayWatchdog();
        const replayGameKey = data?.gameKey || state.liveGameKey;
        if (state.liveGameKey !== replayGameKey || state.liveGameData?.gameKey !== replayGameKey) {
            state.liveGameData = null;
            state.liveSeqNo = -1;
        }
        state.liveGameKey = replayGameKey;
    } else if (message.action === "replayBatch") {
        if (replaying) armReplayWatchdog();
        (data?.messages || []).forEach((replayMessage) => dispatch(replayMessage, { fromReplay: true }));
        if (state.liveGameData) handlers.onUpdate?.(state.liveGameData, message);
    } else if (message.action === "replayComplete") {
        clearReplayWatchdog();
        replaying = false;
        if (Number.isFinite(seqNo)) {
            state.liveSeqNo = Math.max(state.liveSeqNo, seqNo);
        }
        if (state.liveGameData) handlers.onUpdate?.(state.liveGameData, message);
    } else if (LIVE_ACTIONS.has(message.action)) {
        applyLiveMessage(message);
        if (message.action === "newGame") handlers.onNewGame?.(state.liveGameData, message);
        if (message.action === "finaliseGame") {
            handlers.onFinalise?.(state.liveGameData, message);
            state.liveSeqNo = -1;
        }
    }
}

function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
        send("getCurrentGame");
        const queued = pendingActions.splice(0)
            .filter((action) => action !== "subscribe" && action !== "unsubscribe");
        queued.forEach((action) => send(action));
        if (state.liveSubscribed) beginReplay();
    };
    ws.onmessage = (event) => {
        try { dispatch(JSON.parse(event.data)); }
        catch (error) { console.error("Invalid live websocket message", error); }
    };
    ws.onerror = (error) => console.error("Live websocket error", error);
    ws.onclose = () => {
        clearReplayWatchdog();
        replaying = false;
        ws = null;
        setTimeout(connect, 2000);
    };
}

connect();
