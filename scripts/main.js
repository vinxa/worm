// main.js

// Imports
import { state } from "./state.js";
import { showHome, buildGrid, initUI, renderGameData, refreshNextGameButton } from "./ui.js";
import { wiggleLogos } from "./wormThings.js";

const INDEX_REFRESH_MS = 10000;
const FRESH_WINDOW_MINUTES = 15;

function getLatestGame(games) {
    if (!games || !games.length) return null;
    return [...games].sort((a, b) => b.id.localeCompare(a.id))[0];
}

function computeGameSignature(data) {
    if (!data) return "";
    const explicit =
        data.lastUpdated ||
        data.updatedAt ||
        data.timestamp ||
        data.generatedAt;
    if (explicit) return String(explicit);

    const events = Array.isArray(data.events) ? data.events : [];
    const last = events[events.length - 1] || {};
    const lastTime = last.time ?? "";
    const lastDelta = last.playerDelta ?? last.teamDelta ?? last.delta ?? "";
    return `${events.length}|${lastTime}|${lastDelta}|${data.gameDuration ?? ""}`;
}

function parseGameStart(game) {
    if (!game || !game.id) return null;
    const m = game.id.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    const [, YYYY, MM, DD, hh, mm] = m;
    return new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:00+08:00`);
}

function isFreshGame(game) {
    const start = parseGameStart(game);
    if (!start) return false;
    const now = Date.now();
    return now - start.getTime() < FRESH_WINDOW_MINUTES * 60 * 1000;
}

async function fetchGamesIndex(fromPoll = false) {
    try {
        const res = await fetch(state.S3_BASE_URL + "/index.json", { cache: "no-store" });
        if (!res.ok) throw new Error("Couldn't fetch games index");
        const list = await res.json();
        applyGameIndex(list, { fromPoll });
    } catch (err) {
        console.error("Failed to refresh games index:", err);
    }
}

function applyGameIndex(list, { fromPoll = false } = {}) {
    if (!Array.isArray(list)) return;
    const prevGames = state.games || [];
    const prevIds = new Set(prevGames.map((g) => g.id));
    const prevLatestId = state.latestGame?.id;

    state.games = list;
    state.latestGame = getLatestGame(list);

    const newGameIds = fromPoll
        ? list.filter((g) => !prevIds.has(g.id)).map((g) => g.id)
        : [];
    buildGrid(list, newGameIds);

    const latestChanged = state.latestGame?.id && state.latestGame.id !== prevLatestId;
    if (fromPoll && latestChanged) {
        refreshNextGameButton(true, true);
    } else {
        refreshNextGameButton(false, false);
    }

    const viewingLatest =
        fromPoll &&
        state.selectedGame &&
        state.latestGame &&
        state.selectedGame.id === state.latestGame.id;
    if (viewingLatest && isFreshGame(state.latestGame) && !state.isGameLoading) {
        loadGameData(state.latestGame.dataPath, {
            skipIfSignatureUnchanged: true,
            showSpinner: false,
        });
    }
}

export async function loadGameData(dataPath, options = {}) {
    const {
        skipIfSignatureUnchanged = false,
        showSpinner = true,
        prefetchedData = null,
    } = options;
    try {
        state.isGameLoading = true;
        if (showSpinner) showLoadingIndicator();

        const data = prefetchedData
            ? prefetchedData
            : await (await fetch(dataPath, { cache: "no-store" })).json();

        const sigKey = state.selectedGame?.id || data.id || dataPath;
        const newSig = computeGameSignature(data);
        const prevSig = state.gameSignatures[sigKey];
        if (skipIfSignatureUnchanged && prevSig && prevSig === newSig) {
            return;
        }
        state.gameSignatures[sigKey] = newSig;
        state.gameData = data;

        // Index player events
        state.playerEvents = {};
        state.gameData.events.forEach((ev) => {
        const pid = ev.entity;
        if (!state.playerEvents[pid]) state.playerEvents[pid] = [];
            state.playerEvents[pid].push(ev);
        });
        Object.values(state.playerEvents).forEach((arr) =>
            arr.sort((a, b) => a.time - b.time)
        );

        // Duration & current time
        const maxEvent = state.gameData.events.length
        ? Math.max(...state.gameData.events.map((e) => e.time))
        : 0;
        state.gameData.gameDuration = state.gameData.gameDuration ?? maxEvent;
        state.currentTime = state.gameData.gameDuration;

        // Final scores for each player
        state.gameData.playerStats = {};
        Object.entries(state.gameData.players).forEach(([pid, info]) => {
            const finalScore = (state.playerEvents[pid] || []).reduce(
                (sum, ev) => sum + (ev.delta || 0),
                0
            );
            state.gameData.playerStats[pid] = {name: info.name, score: finalScore};
        });

        state.teamScores = {};
        state.gameData.teams.forEach((t) => {
            state.teamScores[t.id] = 0;
        });
        state.visibleTeams = null;

        renderGameData();

    } catch (err) {
        console.error("Failed to load game data:", err);
        
    } finally {
        state.isGameLoading = false;
        if (showSpinner) hideLoadingIndicator();
    }
}

function showLoadingIndicator() {
    state.loadingStart = Date.now();
    document.getElementById('loading-indicator').style.display = 'flex';
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
fetchGamesIndex(false);
setInterval(() => fetchGamesIndex(true), INDEX_REFRESH_MS);


document.addEventListener("DOMContentLoaded", () => {
    initUI();
    showHome();
});
