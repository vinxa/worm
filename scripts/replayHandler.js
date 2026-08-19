import { state } from "./state.js";
import { updatePlayerTiles, updateTeamScoresUI } from "./playerTiles.js";
import { updateLiveSeries, updateCursorPosition } from "./timeline.js";
import { getGameDuration, getLivePresentationTime, initTeamScores } from "./utils.js";
import { closeYouTubeModal } from "./video.js";
import { isLiveGameSelected } from "./live.js";

export function updatePlayButtonsLabel(label) {
  const mainBtn = document.getElementById("playButton");
  const headerBtn = document.getElementById("headerPlayButton");
  [mainBtn, headerBtn].forEach((button) => {
    if (!button) return;
    const isPlaying = label !== "▶";
    button.textContent = "";
    button.classList.toggle("is-playing", isPlaying);
    button.title = isPlaying ? "Pause" : "Play";
    button.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  });
}

export function updateSpeedButtons() {
    const label = `${state.playbackRate}x`;
    const title = state.livePlaybackLocked
        ? "Playback speed is locked at 1x while following a live game"
        : "Change playback speed (+/-)";
    ["speedButton", "headerSpeedButton"].forEach((id) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.textContent = label;
        button.disabled = state.livePlaybackLocked;
        button.title = title;
    });
}

export function handleSkip(delta) {
    if (delta > 0 && isLiveGameSelected()) {
        jumpTo(getLivePresentationTime(state.gameData, state.selectedGame));
        return;
    }

    const maxTime = getGameDuration(state.gameData);
    const newTime = Math.min(maxTime, Math.max(0, state.currentTime + delta));
    jumpTo(newTime);
}

export function setPlaybackRate(rate, { force = false, restart = true } = {}) {
    if (state.livePlaybackLocked && rate !== 1 && !force) {
        updateSpeedButtons();
        return state.playbackRate;
    }
    state.playbackRate = rate;
    if (state.player && typeof state.player.setPlaybackRate === "function") {
        state.player.setPlaybackRate(rate);
    }
    updateSpeedButtons();
    if (restart && state.isPlaying) {
        clearTimeouts();
        playReplay(state.chart, state.gameData, state.playbackRate, state.replayTimeouts, state.currentTime);
    }
    return state.playbackRate;
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
    closeYouTubeModal();
    showGame(state.latestGame);
    return true;
}

export function jumpToStart() {
    jumpTo(0);
}

export function jumpToEnd() {
    const duration = getGameDuration();
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
    // pause video
    if (state.player && typeof state.player.pauseVideo === "function") {
      state.player.pauseVideo();
    }
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

function applyTeamScoreEvent(teamScores, ev, players) {
    const teamId = players?.[ev.entity]?.team;
    if (!teamId || !teamScores[teamId]) return;

    teamScores[teamId].score += ev.delta ?? 0;
    const targetTeam = players?.[ev.target]?.team;
    if (ev.type === "tag" && targetTeam !== teamId) {
        teamScores[teamId].tagsFor++;
    } else if (ev.type === "tagged" && targetTeam !== teamId) {
        teamScores[teamId].tagsAgainst++;
    }
}

export function playReplay(
  chart,
  data,
  rate = 1,
  timeouts = [],
  startSec = 0,
  { skipInitialLiveSeriesUpdate = false, followLiveClock = false } = {}
) {
  if (followLiveClock && isLiveGameSelected()) {
    if (!skipInitialLiveSeriesUpdate) updateLiveSeries(startSec);

    const drawLiveClock = () => {
      state.replayAnimationFrame = null;
      if (!state.isPlaying || !isLiveGameSelected() || state.chart !== chart) return;

      const duration = getGameDuration(state.gameData);
      const liveTime = getLivePresentationTime(state.gameData, state.selectedGame);
      // A delayed snapshot must not make the playhead jump backwards.
      state.currentTime = Math.min(duration, Math.max(state.currentTime, liveTime));
      updateCursorPosition(state.currentTime);

      if (state.currentTime < duration) {
        state.replayAnimationFrame = requestAnimationFrame(drawLiveClock);
      } else {
        state.isPlaying = false;
        updatePlayButtonsLabel("▶");
      }
    };

    state.replayAnimationFrame = requestAnimationFrame(drawLiveClock);
    return;
  }

  // 1) Compute duration
  const duration = getGameDuration(data);
  const playbackEnd = isLiveGameSelected()
    ? Math.max(startSec, Math.min(duration, getLivePresentationTime(data, state.selectedGame)))
    : duration;

  // 2) Sort events by exact time
  const sortedEvents = data.events.slice().sort((a, b) => a.time - b.time);
  let eventIdx = 0;

  // 3) Initialize global teamScores up to startSec
  //    (assumes teamScores = {} declared at top and populated in loadGameData)
  state.teamScores = initTeamScores(data.teams);
  while (
    eventIdx < sortedEvents.length &&
    sortedEvents[eventIdx].time < startSec
  ) {
    applyTeamScoreEvent(state.teamScores, sortedEvents[eventIdx++], data.players);
  }

  // 4) Reset the live‐series to match startSec
  if (!skipInitialLiveSeriesUpdate) updateLiveSeries(startSec);
  // And update the UI for the new teamScores
  updateTeamScoresUI();
  updatePlayerTiles(startSec);

  // 5) Schedule ticks every 0.5s from startSec → playbackEnd.
  // Live games must not replay the unseen future up to their fixed duration.
  const stepSize = 0.5; // seconds
  const stepMillis = stepSize * 1000; // ms
  const totalSteps = Math.max(0, Math.ceil((playbackEnd - startSec) / stepSize));

  for (let i = 0; i <= totalSteps; i++) {
    const t = Math.min(playbackEnd, startSec + i * stepSize);
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
        applyTeamScoreEvent(state.teamScores, sortedEvents[eventIdx++], data.players);
      }

      // b) draw a point for each team at time = t
      const offset = data.teams.length; // ghost series first
      data.teams.forEach((team, idx) => {
        chart.series[offset + idx].addPoint(
          [t, state.teamScores[team.id].score],
          idx === data.teams.length - 1,
          false
        );
      });

      // c) update team-scores list and player tiles
      updateTeamScoresUI();
      updatePlayerTiles(t);

      // d) keep the cursor line and timestamp on the same authoritative time
      updateCursorPosition(t);

      // e) final redraw
      chart.redraw();
      if (t >= playbackEnd) {
        // We’ve reached the end of this replay window. For live games this is
        // the current live timestamp, not the fixed game duration.
        state.isPlaying = false;
        updatePlayButtonsLabel("▶");
        if (state.player && typeof state.player.pauseVideo === "function") {
          state.player.pauseVideo();
        }
        clearTimeouts();
      }
    }, delay);

    timeouts.push(id);
  }
}

export function seekToTime(sec, skipVideoSeek = false, { skipLiveSeriesUpdate = false } = {}) {
  if (!state.gameData) return;
  const duration = getGameDuration(state.gameData);
  // clamp
  sec = Math.max(0, Math.min(sec, duration));
  state.currentTime = sec;

  // mark that we just seeked, so sync won't pull us back
  if (typeof window !== 'undefined' && window.lastProgrammaticSeekAt !== undefined) {
    window.lastProgrammaticSeekAt = Date.now();
  }

  // sync video
  if (!skipVideoSeek && state.player && typeof state.player.seekTo === "function") {
    const offset = parseFloat(document.getElementById("videoOffset")?.value) || 0;
    state.player.seekTo(sec + offset, true);
  }
  updatePlayerTiles(sec);
  state.teamScores = initTeamScores(state.gameData.teams);
  state.gameData.events.forEach((ev) => {
    if (ev.time <= state.currentTime) {
      applyTeamScoreEvent(state.teamScores, ev, state.gameData.players);
    }
  });
  updateTeamScoresUI();
  if (!skipLiveSeriesUpdate) updateLiveSeries(sec);
  updateCursorPosition(state.currentTime);
}

export function clearTimeouts() {
  state.replayTimeouts.forEach(clearTimeout);
  state.replayTimeouts.length = 0;
  if (state.replayAnimationFrame !== null) {
    cancelAnimationFrame(state.replayAnimationFrame);
    state.replayAnimationFrame = null;
  }
}
