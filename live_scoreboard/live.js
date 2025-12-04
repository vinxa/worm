// liveGame.js
//
// Live-game support:
// - Detects live games from WebSocket metadata, not from S3.
// - Applies incoming live events to the in-memory scoreboard when appropriate.
// - Exposes helpers to connect/disconnect WS, mark live tiles, and
//   watch the current live game.

import { state } from "../scripts/state.js";
import { updateTeamScoresUI } from "../scripts/playerTiles.js";
import { loadGameData } from "../scripts/main.js";

/**
 * Determine whether a historical S3-backed game is still in progress.
 */
export function isGameLive(data) {
    if (!data || !data.startTime || data.gameDuration == null) return false;
    try {
        const dt = data.startTime.trim().replace(" ", "T");
        const start = new Date(`${dt}:00`);
        const end = new Date(start.getTime() + data.gameDuration * 1000);
        const now = new Date();
        const hasEndEvent = Array.isArray(data.events) &&
            data.events.some((ev) => ev.type === "game end");
        return !hasEndEvent && now < end;
    } catch (err) {
        console.error("Failed to parse startTime", err);
        return false;
    }
}

/**
 * Open a WebSocket to the live endpoint and wire handlers.
 * Any existing socket is closed first.
 */
export function connectLiveUpdates() {
    const WS_URL = "wss://1km1prnds5.execute-api.ap-southeast-2.amazonaws.com/production";

    if (state.liveReconnectTimeoutId) {
        clearTimeout(state.liveReconnectTimeoutId);
        state.liveReconnectTimeoutId = null;
    }

    if (state.liveWS) {
        try {
            state.liveWS.close();
        } catch (err) {
            console.warn("closing previous live WS failed", err);
        }
        state.liveWS = null;
    }

    const ws = new WebSocket(WS_URL);
    state.liveWS = ws;

    ws.onerror = (err) => console.error("Live WS error", err);
    ws.onclose = () => {
        console.log("Live WS closed");
        // Auto-reconnect after a short delay
        state.liveReconnectTimeoutId = setTimeout(() => {
            connectLiveUpdates();
        }, 1000);
    };
    ws.onopen = () => {
        console.log("Live WS connection established");
        // Ask server to replay cached metadata/events in case we joined mid-game
        state.liveReplayRequested = true;
        ws.send(JSON.stringify({ action: "replay" }));
    };
    ws.onmessage = (event) => {
        console.log(`Live Data received from server: ${event.data}`);
        handleLiveMessage(event);
    };
}

/**
 * Close any existing WebSocket connection opened by connectLiveUpdates().
 */
export function disconnectLiveUpdates() {
    if (state.liveWS) {
        try {
            state.liveWS.close();
        } catch (err) {
            console.warn(err);
        }
        state.liveWS = null;
    }
}

/**
 * Handle metadata for a new live game sent over WebSocket.
 * This is the canonical signal: "a live game has started".
 * @param {Object} meta
 */
function handleLiveMetadata(meta) {
    if (!meta || typeof meta !== "object") return;

    state.liveGameMeta = meta;
    state.liveGameEvents = [];
    state.liveGameHasEnded = false;

    console.log("[live] metadata received:", meta);

    // If user is currently in "watch live" mode, we should initialise the
    // in-memory gameData based on metadata.
    if (state.watchCurrentLive) {
        initialiseLiveGameFromMetadata(meta);
        // Avoid circular import by lazy loading renderGameData
        import("../scripts/ui.js").then(({ renderGameData }) => {
            renderGameData();
            // Apply any events that arrived before metadata
            if (Array.isArray(state.liveGameEvents) && state.liveGameEvents.length) {
                state.liveGameEvents
                    .slice()
                    .sort((a, b) => (a.time || 0) - (b.time || 0))
                    .forEach((ev) => {
                        if (!Array.isArray(state.gameData.events)) {
                            state.gameData.events = [];
                        }
                        state.gameData.events.push(ev);
                        applyEventToScores(ev);
                    });
            }
        });
    }

    // You might also want to update any "current live game" tile on the
    // index page; see markLiveGames() below for that.
}

/**
 * Returns true if the currently viewed game is the live game context.
 * Simplest heuristic: if watchCurrentLive flag is set.
 */
function isCurrentGameLiveContext() {
    return !!state.watchCurrentLive;
}

/**
 * Handler for messages arriving from the live WebSocket.
 * It distinguishes between:
 *   - { action: "metadata", data: { ... } }
 *   - { action: "event",    data: "<json string>" or object }
 * and updates state + UI accordingly.
 * @param {MessageEvent} event
 */
function handleLiveMessage(event) {
    let msg;
    try {
        msg = JSON.parse(event.data);
        console.log(msg);
    } catch (e) {
        console.warn("Live WS non-JSON message:", event.data);
        return;
    }

    // Lambda forwards payloads as { action, data }
    if (msg.action === "metadata") {
        handleLiveMetadata(msg.data);
        return;
    }

    if (msg.action === "event") {
        let ev;
        try {
            if (typeof msg.data === "string") {
                ev = JSON.parse(msg.data);
            } else {
                ev = msg.data;
            }
        } catch (e) {
            console.warn("Received non-JSON event payload", msg.data);
            return;
        }

        if (!ev || typeof ev !== "object") return;

        // Track events for the current live game
        if (!Array.isArray(state.liveGameEvents)) {
            state.liveGameEvents = [];
        }
        state.liveGameEvents.push(ev);

        // If we're currently showing the live game, also apply it to the
        // scoreboard in real time.
        if (state.gameData && isCurrentGameLiveContext()) {
            if (!Array.isArray(state.gameData.events)) {
                state.gameData.events = [];
            }
            state.gameData.events.push(ev);
            applyEventToScores(ev);
        }

        if (ev.type === "game end") {
            state.liveGameHasEnded = true;
        }

        return;
    }

    // Unknown action; ignore.
    if (!state.liveGameMeta && state.liveWS && !state.liveReplayRequested && state.liveWS.readyState === WebSocket.OPEN) {
        // If we started receiving events before metadata, request a replay once.
        state.liveReplayRequested = true;
        state.liveWS.send(JSON.stringify({ action: "replay" }));
    }
}

/**
 * Apply a new event to the scoreboard. Updates both playerStats and
 * teamScores and writes the changes to the DOM.
 * @param {Object} ev A single event from the live feed.
 */
function applyEventToScores(ev) {
    if (!ev || !state.gameData) return;
    const { entity, delta, teamDelta, time } = ev;
    const eventTime = typeof time === "number" ? time : 0;

    // Player score delta
    if (entity && delta != null && !isNaN(delta)) {
        const pid = entity;
        const stats = state.gameData.playerStats && state.gameData.playerStats[pid];
        if (stats) {
            stats.score += delta;
            const scoreEl = document.querySelector(
                `.player-summary[data-player-id="${pid}"] .player-score`
            );
            if (scoreEl) {
                scoreEl.textContent = stats.score;
            }
        }
        const player = state.gameData.players && state.gameData.players[pid];
        if (!player) return; // ignore events for unknown players

        const teamId = player.team;
        state.teamScores[teamId] = (state.teamScores[teamId] || 0) + delta;
        updateTeamScoresUI();
        _appendTeamPoint(teamId, eventTime, state.teamScores[teamId]);
    }

    // Direct team delta
    if (entity && teamDelta != null && !isNaN(teamDelta)) {
        const teamId = entity;
        state.teamScores[teamId] = (state.teamScores[teamId] || 0) + teamDelta;
        updateTeamScoresUI();
        _appendTeamPoint(teamId, eventTime, state.teamScores[teamId]);
    }
}

/**
 * Track live team totals and update the chart series incrementally.
 */
function _appendTeamPoint(teamId, eventTime, total) {
    if (!teamId) return;
    if (!state.teamFullTimeline) state.teamFullTimeline = {};
    if (!Array.isArray(state.teamFullTimeline[teamId])) {
        state.teamFullTimeline[teamId] = [];
    }

    const points = state.teamFullTimeline[teamId];
    // Keep points ordered; if times are increasing, this is just a push.
    points.push([eventTime, total]);

    // Advance current playhead for live mode
    if (typeof eventTime === "number") {
        state.currentTime = Math.max(state.currentTime || 0, eventTime);
    }

    // Update the live chart series if present
    const seriesId = `${teamId}-live`;
    if (state.chart) {
        const liveSeries = state.chart.get(seriesId);
        if (liveSeries) {
            liveSeries.setData(points, false);
            setLiveXAxisMax(eventTime);
            state.chart.redraw();
        }
    }
}

/**
 * For live mode, keep the X-axis scaled to elapsed time (not full duration).
 */
function setLiveXAxisMax(eventTime) {
    if (!state.watchCurrentLive || !state.chart || typeof eventTime !== "number") return;
    const axis = state.chart.xAxis && state.chart.xAxis[0];
    if (!axis) return;

    const newMax = Math.max(eventTime, 10); // keep a little breathing room
    const { min, max } = axis.getExtremes();
    if (Math.abs(max - newMax) < 0.5) return;
    axis.setExtremes(0, newMax, false);
}

/**
 * Initialise state.gameData based on live metadata. This mirrors the shape
 * your historical JSON uses, but starts with an empty events array.
 * You should adapt this to match whatever loadGameData() expects.
 */
function initialiseLiveGameFromMetadata(meta) {
    // Basic skeleton; adjust fields as needed to match your game JSON.
    state.gameData = {
        gameDuration: meta.gameDuration,
        penalty: meta.penalty,
        startTime: meta.startTime,
        gameType: meta.gameType,
        teams: meta.teams,
        players: meta.players,
        events: [],
        playerStats: {},  // your existing code should populate this from players
    };

    // You likely already have logic inside loadGameData() that:
    // - builds playerStats from players,
    // - initialises teamScores,
    // - renders tiles, etc.
    //
    // You can factor that logic into a helper (e.g. setupGameFromData(data))
    // and call it here instead of re-implementing everything.
    //
    // Example (pseudo):
    //   setupGameFromData(state.gameData);
    //
    // For now this just sets gameData; your existing code can detect
    // state.watchCurrentLive and treat this as the live context.
}

/**
 * New implementation: current live game is determined from WebSocket
 * metadata, not from S3. If metadata exists and the game has not yet
 * ended, return a simple descriptor object; otherwise null.
 *
 * This keeps the same signature, but the "game" returned is synthetic
 * (it will not have dataPath).
 */
export async function findCurrentLiveGame() {
    if (state.liveGameMeta && !state.liveGameHasEnded) {
        return {
            id: "Live",
            isLive: true,
            meta: state.liveGameMeta,
        };
    }
    return null;
}

/**
 * "Watch current live game" now means: stop polling S3 and simply
 * treat the WebSocket metadata/events as the source of truth.
 *
 * This function:
 *   - sets state.watchCurrentLive = true
 *   - connects WS if needed
 *   - if metadata is already present, initialises gameData from it.
 */
export function watchCurrentLiveGame() {
    if (state.watchIntervalId) {
        clearInterval(state.watchIntervalId);
        state.watchIntervalId = null;
    }

    state.watchCurrentLive = true;

    // Ensure WebSocket is connected
    if (!state.liveWS || state.liveWS.readyState !== WebSocket.OPEN) {
        connectLiveUpdates();
    }

    // If we already have metadata, initialise immediately
    if (state.liveGameMeta && !state.liveGameHasEnded) {
        initialiseLiveGameFromMetadata(state.liveGameMeta);
    }

    // We no longer poll S3 here. All live updates come from WebSocket.
}

/**
 * Mark live games on the index page. With WebSocket-based detection, we
 * don't need to fetch each game from S3. Instead:
 *   - if state.liveGameMeta exists and the tile corresponds to that game,
 *     prefix it with a red dot.
 *
 * This assumes your tiles have data-game-id attributes that you can map to
 * live metadata (e.g. by startTime + gameType or some other identifier).
 *
 * For now, this function simply adds a generic "Current live game" marker
 * without attempting to match specific tiles, because the live game may not
 * yet exist in S3/index.json at all.
 */
export function markLiveGames(games) {
    if (!state.liveGameMeta || state.liveGameHasEnded) return;

    // Just mark the dedicated live tile
    const liveTile = document.querySelector(".live-tile");

    if (liveTile && !liveTile.textContent.startsWith("🔴")) {
        liveTile.textContent = "🔴 Watch Live Games";
    }
}
