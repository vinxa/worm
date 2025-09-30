// main.js

// Imports
import { state } from "./state.js";
import { showHome, buildGrid, initUI, renderGameData } from "./ui.js";

export async function loadGameData(dataPath) {
    try {
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
}

// Load list of games
let games = [];
fetch(state.S3_BASE_URL + "/index.json").then(res => {
    if (!res.ok) throw new Error("Couldn't fetch games index");
    return res.json();
})
.then(list => { 
    games = list;
    buildGrid(games);
})
.catch(err => console.error(err));


document.addEventListener("DOMContentLoaded", () => {
    initUI();
    showHome();
});
