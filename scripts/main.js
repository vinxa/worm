// main.js

// 1) Imports
import { initLiveChart, buildTeamTimeline, buildPlayerTimelines } from "./chart.js";
import { formatGameDatetime, isTypingField } from "./utils.js";
import { wiggleLogos, setupLogoDance } from "./logo.js";
import { generatePlayerTiles, buildGrid, colorPlayerNamesFromChart, setupTileExpansion, setupPlayerSeriesToggles } from "./playerTiles.js";
import { setupDraggableModal } from "./video.js";
import { state } from "./state.js";
import { playReplay, seekToTime, handleSkip } from "./replay.js";

// Fetch JSON & bootstrap everything
async function loadGameData(dataPath) {
    try {
        // ← Adjusted path to where sample-game.json actually lives
        const res = await fetch(dataPath);
        state.gameData = await res.json();
        state.playerEvents = {};
        state.gameData.events.forEach((ev) => {
        const pid = ev.entity;
        if (!state.playerEvents[pid]) state.playerEvents[pid] = [];
        state.playerEvents[pid].push(ev);
        });
        Object.values(state.playerEvents).forEach((arr) =>
        arr.sort((a, b) => a.time - b.time)
        );

        // 2) compute and store gameDuration & currentTime at the end
        const maxEvent = state.gameData.events.length
        ? Math.max(...state.gameData.events.map((e) => e.time))
        : 0;
        state.gameData.gameDuration = state.gameData.gameDuration ?? maxEvent;
        state.currentTime = state.gameData.gameDuration;

        // Compute final scores for each player
        state.gameData.playerStats = {};
        Object.entries(state.gameData.players).forEach(([pid, info]) => {
        const finalScore = (state.playerEvents[pid] || []).reduce(
            (sum, ev) => sum + (ev.delta || 0),
            0
        );
        state.gameData.playerStats[pid] = {
            name: info.name,
            score: finalScore,
        };
        });

        state.teamScores = {};
        state.gameData.teams.forEach((t) => {
        state.teamScores[t.id] = 0;
        });

        // 4a) Build and show the live‐update chart
        state.chart = initLiveChart(state.gameData);
        state.teamFullTimeline = buildTeamTimeline(state.gameData);
        state.playerTimelines = buildPlayerTimelines(state.gameData);

        // 4b) Build the 15 player tiles
        generatePlayerTiles();
        setupTileExpansion();
        setupPlayerSeriesToggles();
        colorPlayerNamesFromChart();

        // 4d) Wire up the draggable YouTube modal
        setupDraggableModal();
        seekToTime(state.currentTime);

        // 4e) Hook the "Play" button to start the replay
        document.getElementById("playButton").addEventListener("click", () => {
        const btn = document.getElementById("playButton");
        if (!state.gameData) return; // safety
        if (state.currentTime >= state.gameData.gameDuration) {
            seekToTime(0);
        }
        if (!state.isPlaying) {
            state.isPlaying = true;
            btn.textContent = "❚❚"; // pause icon
            // clear any old timeouts
            state.replayTimeouts.forEach((id) => clearTimeout(id));
            state.replayTimeouts.length = 0;
            // start replay, passing our array to fill with timeout IDs
            playReplay(state.chart, state.gameData, 1, state.replayTimeouts, state.currentTime);
            if (state.player && typeof state.player.playVideo === "function") {
            state.player.playVideo();
            }
        } else {
            state.isPlaying = false;
            btn.textContent = "▶"; // back to play icon
            state.replayTimeouts.forEach((id) => clearTimeout(id));
            state.replayTimeouts.length = 0;
            if (state.player && typeof state.player.pauseVideo === "function") {
            state.player.pauseVideo();
            }
            // cancel pending events
            state.replayTimeouts.forEach((id) => clearTimeout(id));
        }
        });

        document
        .getElementById("rewindButton")
        .addEventListener("click", () => handleSkip(-15));
        document
        .getElementById("forwardButton")
        .addEventListener("click", () => handleSkip(+15));

        document.addEventListener("keydown", (e) => {
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
        });
        wiggleLogos();
        if ( state.selectedGame && state.gameData.gameType) {
    const pretty = formatGameDatetime(state.selectedGame.id);
    document.querySelector('.title').textContent =
        `${pretty}    |    ${state.gameData.gameType}`;
    }
    } catch (err) {
        console.error("Failed to load game data:", err);
    }
}

// 4) view-switching functions
function showHome() {
  homeView.style.display = 'block';
  leftBtn.style.display = 'none';
  gameHeader.style.display = 'none';
  gameSections.forEach(s => s.style.display = 'none');
}

export function showGame(game) {
  state.selectedGame = game;
  // hide home
  homeView.style.display = 'none';
  // show game UI
  leftBtn.style.display = 'inline-block';
  gameHeader.style.display = 'flex';
  gameSections.forEach(s => s.style.display = '');
  // load your existing data
  loadGameData(game.dataPath);
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

// 2) grab the two views and the left-arrow button
const homeView = document.getElementById('home-view');
const gameHeader = document.querySelector('body > .app-header');
const gameSections = [
  document.querySelector('.top-section'),
  document.querySelector('.timeline-section')
];
const leftBtn = document.querySelector('.nav-button.left');

// 5) wire up the “back” arrow
leftBtn.addEventListener('click', showHome);

// 6) initialize
showHome();


// 11) Start everything once the DOM is ready
// document.addEventListener("DOMContentLoaded", loadGameData);


document.addEventListener("DOMContentLoaded", () => {
    setupLogoDance();
    wiggleLogos();
});
