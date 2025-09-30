// script.js

// 1) Imports
import { initLiveChart, updateLiveSeries, updateCursorPosition, setupPlayerSeriesToggles, buildTeamTimeline, buildPlayerTimelines } from "./chart.js";
import { formatTime, formatGameDatetime, isTypingField } from "./utils.js";
import { wiggleLogos, setupLogoDance } from "./logo.js";
import { generatePlayerTiles, updatePlayerTiles, buildGrid, colorPlayerNamesFromChart, setupTileExpansion, updateTeamScoresUI } from "./playerTiles.js";
import { setupDraggableModal } from "./video.js";
import { state } from "./state.js";


function handleSkip(delta) {
    // a) If a replay is running, cancel every scheduled tick:
    if (state.isPlaying) {
        state.replayTimeouts.forEach((id) => clearTimeout(id));
        state.replayTimeouts = [];
    }

    // b) Compute & clamp the new time:
    const maxTime =
        state.gameData.gameDuration ?? Math.max(...gameData.events.map((e) => e.time));
    const newTime = Math.min(maxTime, Math.max(0, state.currentTime + delta));

    // c) Seek all UI & chart to newTime:
    seekToTime(newTime);

    // d) If we were playing, start a fresh replay from newTime
    if (state.isPlaying) {
        playReplay(state.chart, state.gameData, 1, state.replayTimeouts, state.currentTime);
    }
}

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
            state.replayTimeouts = [];
            // start replay, passing our array to fill with timeout IDs
            playReplay(state.chart, state.gameData, 1, state.replayTimeouts, state.currentTime);
            if (state.player && typeof state.player.playVideo === "function") {
            state.player.playVideo();
            }
        } else {
            state.isPlaying = false;
            btn.textContent = "▶"; // back to play icon
            state.replayTimeouts.forEach((id) => clearTimeout(id));
            state.replayTimeouts = [];
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


/**
 * Play back the game in real time, resuming from `startSec`.
 * Fires every 0.5s, updates both the chart and the team‐score UI.
 *
 * @param {Highcharts.Chart} chart
 * @param {Object}           data       your gameData
 * @param {number}           rate       speed multiplier
 * @param {Array<number>}    timeouts   array to collect setTimeout IDs
 * @param {number}           startSec   second to begin playback from
 */
export function playReplay(chart, data, rate = 1, timeouts = [], startSec = 0) {
  // 1) Compute duration
  const maxEventTime = data.events.length
    ? Math.max(...data.events.map((e) => e.time))
    : 0;
  const duration = data.gameDuration != null ? data.gameDuration : maxEventTime;

  // 2) Sort events by exact time
  const sortedEvents = data.events.slice().sort((a, b) => a.time - b.time);
  let eventIdx = 0;

  // 3) Initialize global teamScores up to startSec
  //    (assumes teamScores = {} declared at top and populated in loadGameData)
  data.teams.forEach((t) => {
    state.teamScores[t.id] = 0;
  });
  while (
    eventIdx < sortedEvents.length &&
    sortedEvents[eventIdx].time < startSec
  ) {
    const ev = sortedEvents[eventIdx++];
    const teamId =
      ev.teamDelta != null ? ev.entity : data.players[ev.entity].team;
    state.teamScores[teamId] += ev.teamDelta ?? ev.delta ?? 0;
  }

  // 4) Reset the live‐series to match startSec
  updateLiveSeries(startSec);
  // And update the UI for the new teamScores
  updateTeamScoresUI();
  updatePlayerTiles(startSec);

  // 5) Schedule ticks every 0.5s from startSec → duration
  const stepSize = 0.5; // seconds
  const stepMillis = stepSize * 1000; // ms
  const totalSteps = Math.ceil((duration - startSec) / stepSize);

  for (let i = 0; i <= totalSteps; i++) {
    const t = startSec + i * stepSize;
    const delay = (i * stepMillis) / rate;

    const id = setTimeout(() => {
      if (!state.isPlaying) return;

      // Keep currentTime in sync!
      state.currentTime = t;

      // a) apply any events whose time ≤ t
      while (
        eventIdx < sortedEvents.length &&
        sortedEvents[eventIdx].time <= t
      ) {
        const ev = sortedEvents[eventIdx++];
        const teamId =
          ev.teamDelta != null ? ev.entity : data.players[ev.entity].team;
        state.teamScores[teamId] += ev.teamDelta ?? ev.delta ?? 0;
      }

      // b) draw a point for each team at time = t
      const offset = data.teams.length; // ghost series first
      data.teams.forEach((team, idx) => {
        chart.series[offset + idx].addPoint(
          [t, state.teamScores[team.id]],
          idx === data.teams.length - 1,
          false
        );
      });

      // c) update team-scores list and player tiles
      updateTeamScoresUI();
      updatePlayerTiles(t);

      // d) move the cursor group smoothly
      const x = chart.xAxis[0].toPixels(t, false);
      const dx = x - chart.plotLeft;
      chart.customCursorGroup.animate(
        { translateX: dx },
        { duration: stepMillis, easing: "linear" }
      );
      chart.customCursorGroup.element.querySelector("text").firstChild.data =
        formatTime(t);

      // e) final redraw
      chart.redraw();
      if (t >= duration) {
        // we’ve reached (or passed) the end
        state.isPlaying = false;
        document.getElementById("playButton").textContent = "▶";
        // clear any leftover timeouts
        state.replayTimeouts.forEach((id) => clearTimeout(id));
        state.replayTimeouts = [];
      }
    }, delay);

    timeouts.push(id);
  }
}

export function seekToTime(sec) {
  if (!state.gameData) return;
  const duration =
    state.gameData.gameDuration ?? Math.max(...state.gameData.events.map((e) => e.time));
  // clamp
  sec = Math.max(0, Math.min(sec, duration));
  state.currentTime = sec;

  // sync video
  if (state.player && typeof state.player.seekTo === "function") {
    state.player.seekTo(sec, true);
  }

  // 1) update tiles
  updatePlayerTiles(sec);

  // 2) update team‐score list
  updateTeamScoresForTime(state.currentTime);

  // 3) update live series
  updateLiveSeries(sec);

  // 4) move cursor line
  updateCursorPosition(state.currentTime);
}

function updateTeamScoresForTime(sec) {
  // 1) zero out every team
  state.gameData.teams.forEach((t) => {
    state.teamScores[t.id] = 0;
  });

  // 2) scan every event ≤ sec and add its teamDelta/delta
  state.gameData.events.forEach((ev) => {
    if (ev.time <= sec) {
      const teamId =
        ev.teamDelta != null ? ev.entity : state.gameData.players[ev.entity].team;
      state.teamScores[teamId] += ev.teamDelta ?? ev.delta ?? 0;
    }
  });

  // 3) repaint the UL
  updateTeamScoresUI();
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
