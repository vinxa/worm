import { state } from "./state.js";
import { updatePlayerTiles, updateTeamScoresUI } from "./playerTiles.js";
import { updateLiveSeries, updateCursorPosition } from "./timeline.js";
import { getGameDuration, getLivePresentationTime, initTeamScores } from "./utils.js";
import { closeYouTubeModal } from "./video.js";
import { isLiveGameSelected } from "./live.js";
import { isAtLiveEdge, resolveLivePlayheadTime } from "./livePlayhead.js";
import { setShortcutTooltip } from "./shortcutTooltips.js";

const LIVE_MANUAL_SEEK_TOLERANCE_SECONDS = 0.75;

function isLiveSpeedLocked() {
    return state.livePlaybackLocked && state.livePlayheadFollowing;
}

export function updateResumeLiveButtons() {
    const hidden = !state.livePlaybackLocked || state.livePlayheadFollowing;
    ["resumeLiveButton", "headerResumeLiveButton"].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.hidden = hidden;
    });
}

export function detachLivePlayback() {
    if (!state.livePlaybackLocked || !state.livePlayheadFollowing) return;
    state.livePlayheadFollowing = false;
    updateResumeLiveButtons();
    updateSpeedButtons();
}

export function updatePlayButtonsLabel(label) {
  ["playButton", "headerPlayButton"].forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    const isPlaying = label !== "▶";
    button.textContent = "";
    button.classList.toggle("is-playing", isPlaying);
    setShortcutTooltip(button, isPlaying ? "Pause" : "Play");
    button.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  });
}

export function updateSpeedButtons() {
    const label = `${state.playbackRate}x`;
    const locked = isLiveSpeedLocked();
    const title = locked
        ? "Playback speed is locked at 1x while following a live game"
        : "Change playback speed";
    ["speedButton", "headerSpeedButton"].forEach((id) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.textContent = label;
        button.disabled = locked;
        setShortcutTooltip(button, title);
    });
}

export function handleSkip(delta) {
    const maxTime = isLiveGameSelected()
        ? getLivePresentationTime(state.gameData, state.selectedGame)
        : getGameDuration(state.gameData);
    jumpTo(Math.min(maxTime, Math.max(0, state.currentTime + delta)));
}

export function setPlaybackRate(rate, { force = false, restart = true } = {}) {
    if (isLiveSpeedLocked() && rate !== 1 && !force) {
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
    if (isLiveGameSelected()) {
        resumeLivePlayback();
        return;
    }
    jumpTo(getGameDuration());
}

export function togglePlayback() {
    if (!state.gameData) return null;
    if (state.isPlaying && state.livePlayheadFollowing) detachLivePlayback();
    if (!state.isPlaying && isLiveGameSelected() && isAtLiveEdge(
        state.currentTime,
        getLivePresentationTime(state.gameData, state.selectedGame),
    )) {
        return resumeLivePlayback();
    }
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
    if (typeof state.player?.pauseVideo === "function") state.player.pauseVideo();
    return false;
}

export function jumpTo(time) {
    if (!state.gameData) return;
    if (isLiveGameSelected()) {
        const liveTime = getLivePresentationTime(state.gameData, state.selectedGame);
        if (isAtLiveEdge(time, liveTime)) {
            resumeLivePlayback();
            return;
        }
        detachLivePlayback();
    }
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
  if (followLiveClock && isLiveGameSelected() && state.livePlayheadFollowing) {
    if (!skipInitialLiveSeriesUpdate) updateLiveSeries(startSec);

    const drawLiveClock = () => {
      state.replayAnimationFrame = null;
      if (!state.isPlaying || !isLiveGameSelected() ||
          !state.livePlayheadFollowing || state.chart !== chart) return;

      const duration = getGameDuration(state.gameData);
      const liveTime = getLivePresentationTime(state.gameData, state.selectedGame);
      // A delayed snapshot must not make the playhead jump backwards.
      state.currentTime = resolveLivePlayheadTime({
        currentTime: state.currentTime,
        presentationTime: liveTime,
        duration,
        following: true,
      });
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

  const duration = getGameDuration(data);
  const playbackEnd = isLiveGameSelected()
    ? Math.max(startSec, Math.min(duration, getLivePresentationTime(data, state.selectedGame)))
    : duration;

  const sortedEvents = data.events.slice().sort((a, b) => a.time - b.time);
  let eventIdx = 0;

  state.teamScores = initTeamScores(data.teams);
  while (
    eventIdx < sortedEvents.length &&
    sortedEvents[eventIdx].time < startSec
  ) {
    applyTeamScoreEvent(state.teamScores, sortedEvents[eventIdx++], data.players);
  }

  if (!skipInitialLiveSeriesUpdate) updateLiveSeries(startSec);
  updateTeamScoresUI();
  updatePlayerTiles(startSec);

  const stepSize = 0.5;
  const totalSteps = Math.max(0, Math.ceil((playbackEnd - startSec) / stepSize));

  for (let i = 0; i <= totalSteps; i++) {
    const t = Math.min(playbackEnd, startSec + i * stepSize);
    timeouts.push(setTimeout(() => {
      // A live update can replace both the normalized data object and the
      // chart while this detached replay has queued ticks. Never mutate that
      // stale Highcharts instance after the live renderer has moved on.
      if (!state.isPlaying || state.chart !== chart || state.gameData !== data) return;

      state.currentTime = t;

      while (
        eventIdx < sortedEvents.length &&
        sortedEvents[eventIdx].time <= t
      ) {
        applyTeamScoreEvent(state.teamScores, sortedEvents[eventIdx++], data.players);
      }

      // Replace every visible live series as one batch. Calling addPoint with
      // redraw enabled for the final team fired Highcharts' render callback
      // halfway through each replay tick, then redrew the chart a second time
      // below. A buffered live refresh landing between those render cycles
      // could leave axes, series, and custom overlays out of sync.
      updateLiveSeries(t);

      updateTeamScoresUI();
      updatePlayerTiles(t);

      updateCursorPosition(t);
      if (t >= playbackEnd) {
        // We’ve reached the end of this replay window. For live games this is
        // the current live timestamp, not the fixed game duration.
        state.isPlaying = false;
        updatePlayButtonsLabel("▶");
        if (typeof state.player?.pauseVideo === "function") state.player.pauseVideo();
        clearTimeouts();
      }
    }, i * stepSize * 1000 / rate));
  }
}

export function resumeLivePlayback() {
  if (!state.gameData || !isLiveGameSelected()) return false;
  state.livePlayheadFollowing = true;
  state.isPlaying = true;
  clearTimeouts();
  setPlaybackRate(1, { force: true, restart: false });
  seekToTime(getLivePresentationTime(state.gameData, state.selectedGame));
  updateResumeLiveButtons();
  updatePlayButtonsLabel("❚❚");
  playReplay(
    state.chart,
    state.gameData,
    state.playbackRate,
    state.replayTimeouts,
    state.currentTime,
    { followLiveClock: true },
  );
  if (typeof state.player?.playVideo === "function") state.player.playVideo();
  return true;
}

export function seekToTime(
  sec,
  skipVideoSeek = false,
  { skipLiveSeriesUpdate = false, userInitiated = false } = {},
) {
  if (!state.gameData) return;
  sec = Math.max(0, Math.min(sec, getGameDuration(state.gameData)));
  if (userInitiated && isLiveGameSelected() &&
      sec < state.currentTime - LIVE_MANUAL_SEEK_TOLERANCE_SECONDS) {
    detachLivePlayback();
  }
  state.currentTime = sec;

  if (!skipVideoSeek && typeof state.player?.seekTo === "function") {
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
