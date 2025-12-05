// main.js

// Imports
import { state } from "./state.js";
import { showHome, buildGrid, initUI, renderGameData } from "./ui.js";
import { wiggleLogos } from "./wormThings.js";

function getLatestGame(games) {
    if (!games || !games.length) return null;
    return [...games].sort((a, b) => b.id.localeCompare(a.id))[0];
}

export async function loadGameData(dataPath) {
    try {
        state.isGameLoading = true;
        showLoadingIndicator();
        const res = await fetch(dataPath);
        state.gameData = await res.json();

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

        renderGameData();

    } catch (err) {
        console.error("Failed to load game data:", err);
        
    }
    state.isGameLoading = false;
    hideLoadingIndicator();
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

// Load list of games
let games = [];
fetch(state.S3_BASE_URL + "/index.json").then(res => {
    if (!res.ok) throw new Error("Couldn't fetch games index");
    return res.json();
})
.then(list => { 
    games = list;
    state.games = list;
    state.latestGame = getLatestGame(list);
    buildGrid(games);
})
.catch(err => console.error(err));


document.addEventListener("DOMContentLoaded", () => {
    initUI();
    showHome();
});
