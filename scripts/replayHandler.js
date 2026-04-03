import { state } from "./state.js";
import { updatePlayerTiles, updateTeamScoresUI } from "./playerTiles.js";
import { updateLiveSeries, updateCursorPosition } from "./timeline.js";
import { formatTime, getGameDuration } from "./utils.js";

function updatePlayButtonsLabel(label) {
  const mainBtn = document.getElementById("playButton");
  const headerBtn = document.getElementById("headerPlayButton");
  if (mainBtn) mainBtn.textContent = label;
  if (headerBtn) headerBtn.textContent = label;
}



export function handleSkip(delta) {
    // a) If a replay is running, cancel every scheduled tick:
    if (state.isPlaying) clearTimeouts();
    // b) Compute & clamp the new time:
    const maxTime = getGameDuration(state.gameData);
    const newTime = Math.min(maxTime, Math.max(0, state.currentTime + delta));

    // c) Seek all UI & chart to newTime:
    seekToTime(newTime);

    // d) If we were playing, start a fresh replay from newTime
    if (state.isPlaying) {
        playReplay(state.chart, state.gameData, state.playbackRate, state.replayTimeouts, state.currentTime);
    }
}

export function setPlaybackRate(rate) {
    state.playbackRate = rate;
    if (state.isPlaying) {
        clearTimeouts();
        playReplay(state.chart, state.gameData, state.playbackRate, state.replayTimeouts, state.currentTime);
    }
}

export function stepPlaybackRate(direction, options = {}) {
    const speeds = options.speeds || [0.5, 1, 1.5, 2, 4];
    const idx = speeds.indexOf(state.playbackRate);
    const safeIdx = idx === -1 ? 0 : idx;
    const nextIdx = (safeIdx + direction + speeds.length) % speeds.length;
    setPlaybackRate(speeds[nextIdx]);
    return state.playbackRate;
}

export function goToLatestGame({ showGame } = {}) {
    if (!state.latestGame || typeof showGame !== "function") return false;
    state.selectedPlayers = new Set();
    showGame(state.latestGame);
    return true;
}

export function jumpToStart({ loadGameAtIndex } = {}) {
    const atStart = state.currentTime <= 0.01;
    if (atStart && typeof loadGameAtIndex === "function") {
        const games = state.games || [];
        if (state.selectedGame) {
            const currentIdx = games.findIndex((g) => g.id === state.selectedGame.id);
            if (currentIdx !== -1 && loadGameAtIndex(currentIdx + 1)) return;
        }
    }
    jumpTo(0);
}

export function jumpToEnd({ loadGameAtIndex } = {}) {
    const duration = getGameDuration();
    const atEnd = duration > 0 && state.currentTime >= duration - 0.01;
    if (atEnd && typeof loadGameAtIndex === "function") {
        const games = state.games || [];
        if (state.selectedGame) {
            const currentIdx = games.findIndex((g) => g.id === state.selectedGame.id);
            if (currentIdx > 0 && loadGameAtIndex(currentIdx - 1)) return;
        }
    }
    jumpTo(duration);
}

export function togglePlayback() {
    if (!state.gameData) return null;
    if (state.currentTime >= getGameDuration()) {
        seekToTime(0);
    }
    if (!state.isPlaying) {
        state.isPlaying = true;
        clearTimeouts();
        playReplay(state.chart, state.gameData, state.playbackRate, state.replayTimeouts, state.currentTime);
        return true;
    }
    state.isPlaying = false;
    clearTimeouts();
    return false;
}

export function jumpTo(time) {
    if (!state.gameData) return;
    if (state.isPlaying) clearTimeouts();
    seekToTime(time);
    if (state.isPlaying) {
        playReplay(state.chart, state.gameData, state.playbackRate, state.replayTimeouts, state.currentTime);
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
  const duration = getGameDuration(data);

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
        updatePlayButtonsLabel("▶");
        // clear any leftover timeouts
        clearTimeouts();
      }
    }, delay);

    timeouts.push(id);
  }
}

export function seekToTime(sec) {
  if (!state.gameData) return;
  const duration = getGameDuration(state.gameData);
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

export function clearTimeouts() {
  state.replayTimeouts.forEach(clearTimeout);
  state.replayTimeouts.length = 0;
}
