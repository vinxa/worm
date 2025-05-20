// script.js

// 1) Load the YouTube IFrame API
const ytTag = document.createElement("script");
ytTag.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(ytTag);

// 2) Globals
let gameData = null;
let playerEvents = {};
let chart, player;
let isPlaying = false;
let replayTimeouts = [];
let currentTime = 0;
let teamScores = {};
let teamFullTimeline = {};  // will hold per‐second arrays from buildTeamTimeline

// 3) YouTube API ready callback
function onYouTubeIframeAPIReady() {
  console.log("YouTube IFrame API ready");
}

function updatePlayerTiles(currentTime) {
  document.querySelectorAll(".player-summary").forEach((tile) => {
    const pid = tile.dataset.playerId;
    const events = playerEvents[pid] || [];
    let score = 0;
    for (let ev of events) {
      if (ev.time <= currentTime) {
        // sum the playerDelta (fallback to ev.delta if needed)
        score += ev.playerDelta ?? ev.delta ?? 0;
      } else {
        break;
      }
    }
    // update the tile
    const scoreEl = tile.querySelector(".player-score");
    if (scoreEl) scoreEl.textContent = score;
    tile.classList.toggle("_negative", score < 0);
  });
}

// 4) Fetch JSON & bootstrap everything
async function loadGameData() {
  try {
    // ← Adjusted path to where sample-game.json actually lives
    const res = await fetch("data/sample-game.json");
    gameData = await res.json();
    playerEvents = {};
    gameData.events.forEach((ev) => {
      const pid = ev.entity;
      if (!playerEvents[pid]) playerEvents[pid] = [];
      playerEvents[pid].push(ev);
    });
    Object.values(playerEvents).forEach((arr) =>
      arr.sort((a, b) => a.time - b.time)
    );

    // Compute final scores for each player
    gameData.playerStats = {};
    Object.entries(gameData.players).forEach(([pid, info]) => {
      const finalScore = (playerEvents[pid] || []).reduce(
        (sum, ev) => sum + (ev.delta || 0),
        0
      );
      gameData.playerStats[pid] = {
        name: info.name,
        score: finalScore,
      };
    });

    teamScores = {};
    gameData.teams.forEach((t) => {
      teamScores[t.id] = 0;
    });

    // 4a) Build and show the live‐update chart
    chart = initLiveChart(gameData);
    teamFullTimeline = buildTeamTimeline(gameData);

    // 4b) Build the 15 player tiles
    generatePlayerTiles();

    // 4c) Wire up tile‐expansion on click
    setupTileExpansion();

    // 4d) Wire up the draggable YouTube modal
    setupDraggableModal();

    // 4e) Hook the "Play" button to start the replay
    document.getElementById("playButton").addEventListener("click", () => {
      const btn = document.getElementById("playButton");
      if (!gameData) return; // safety
      if (!isPlaying) {
        isPlaying = true;
        btn.textContent = "❚❚"; // pause icon
        // clear any old timeouts
        replayTimeouts.forEach(id => clearTimeout(id));
        replayTimeouts = [];
        // start replay, passing our array to fill with timeout IDs
        playReplay(chart, gameData, 1, replayTimeouts, currentTime);
      } else {
        isPlaying = false;
        btn.textContent = "▶"; // back to play icon
        // cancel pending events
        replayTimeouts.forEach((id) => clearTimeout(id));
      }
      document.getElementById("rewindButton").addEventListener("click", () => {
         seekToTime(currentTime - 15);
  if (isPlaying) {
    replayTimeouts.forEach(id => clearTimeout(id));
    replayTimeouts = [];
    playReplay(chart, gameData, 1, replayTimeouts, currentTime);
  }
      });
      document.getElementById("forwardButton").addEventListener("click", () => {
  seekToTime(currentTime + 15);
  if (isPlaying) {
    replayTimeouts.forEach(id => clearTimeout(id));
    replayTimeouts = [];
    playReplay(chart, gameData, 1, replayTimeouts, currentTime);
  }
      });
    });
  } catch (err) {
    console.error("Failed to load game data:", err);
  }
}

// 5) Initialize an empty chart for live replay
function initLiveChart(data) {
  const duration =
    data.gameDuration || Math.max(...(data.events || []).map((e) => e.time));
  const liveSeries = data.teams.map((t) => ({
    name: t.name,
    data: [[0, 0]],
    color: t.color,
    zIndex: 2,
  }));
  const ghostSeries = data.teams.map((t) => ({
    id: t.id + "-ghost",
    name: t.name,
    data: teamFullTimeline[t.id],
    color: hexToRGBA(t.color, 0.4),
    enableMouseTracking: false,
    showInLegend: false,
    zIndex: 1,
  }));

  const cchart = Highcharts.chart("scoreChart", {
    chart: { type: "line", backgroundColor: "#2a2a2a" },
    title: { text: null },
    xAxis: {
      gridLineWidth: 1,
      gridLineColor: "rgba(136, 136, 136, 0.3)",
      min: 0,
      max: gameData.gameDuration, // full game length in seconds
      // ─────────────────────────────────
      // Major ticks every 60s (one per minute):
      tickInterval: 60,
      // Minor ticks every 1s (for every second):
      minorTickInterval: 0.5,
      // Draw minor tick marks:
      minorTickLength: 5,
      minorGridLineWidth: 0.5,
      // Label styling:
      labels: {
        style: { color: "#ccc" },
        formatter: function () {
          const m = Math.floor(this.value / 60),
            s = this.value % 60;
          return m + ":" + (s < 10 ? "0" + s : s);
        },
      },
    },

    yAxis: {
      title: { text: "Score", style: { color: "#ccc" } },
      gridLineWidth: 0,
      gridLineColor: "rgba(136, 136, 136, 0.3)",
      labels: { style: { color: "#ccc" }},
      plotLines: [{
        value: 0,
        color: '#888',
        width: 1,
        zIndex: 5,
        dashStyle: "Dash"
      }]
    },
    series: [...ghostSeries, ...liveSeries],
    credits: { enabled: false },
    legend: { enabled: false, itemStyle: { color: "#eee" } },
  });

  cchart.xAxis[0].addPlotLine({
    id: "cursor-line",
    value: 0,
    color: "#888",
    width: 2,
    zIndex: 5,
    dashStyle: "Dash",
  });

  return cchart;
}

/**
 * Play back the game in real time, resuming from `startSec`.
 *
 * @param {Highcharts.Chart} chart
 * @param {Object} data       your gameData
 * @param {number} rate       speed multiplier
 * @param {Array<number>} timeouts  array to collect setTimeout IDs
 * @param {number} startSec   second to begin playback from
 */
function playReplay(chart, data, rate = 1, timeouts = [], startSec = 0) {
  const duration = data.gameDuration 
    ?? Math.max(...data.events.map(e => e.time));

  // 1) Bucket events by second for quick lookup
  const eventsByTime = {};
  data.events.forEach(ev => {
    if (!eventsByTime[ev.time]) eventsByTime[ev.time] = [];
    eventsByTime[ev.time].push(ev);
  });

  // 2) Initialize running team scores to the state at startSec
  const lastTeamScores = {};
  data.teams.forEach(t => lastTeamScores[t.id] = 0);

  data.events.forEach(ev => {
    if (ev.time < startSec) {
      const teamId = ev.teamDelta != null
        ? ev.entity
        : data.players[ev.entity].team;
      lastTeamScores[teamId] += (ev.teamDelta ?? ev.delta ?? 0);
    }
  });

  // 3) Reset the live series so it shows exactly up to startSec
  updateLiveSeries(startSec);

  // 4) Schedule every second from startSec → duration
  for (let t = startSec; t <= duration; t++) {
    const delay = ((t - startSec) * 1000) / rate;

    const id = setTimeout(() => {
      if (!isPlaying) return;  // paused?

      // a) apply any deltas at this second
      (eventsByTime[t] || []).forEach(ev => {
        const teamId = ev.teamDelta != null
          ? ev.entity
          : data.players[ev.entity].team;
        lastTeamScores[teamId] += (ev.teamDelta ?? ev.delta ?? 0);
      });

      // b) push a new point for each team
      const offset = data.teams.length;  // ghost series come first
      data.teams.forEach((team, idx) => {
        chart.series[offset + idx].addPoint(
          [t, lastTeamScores[team.id]],
          idx === data.teams.length - 1,
          false
        );
      });

      // c) update tiles, team UI, and move cursor
      updatePlayerTiles(t);
      updateTeamScoresUI();

      const axis = chart.xAxis[0];
      axis.removePlotLine('cursor-line');
      axis.addPlotLine({
        id:        'cursor-line',
        value:     t,
        color:     '#888',
        width:     2,
        dashStyle: 'Dash',
        zIndex:    5
      });
    }, delay);

    timeouts.push(id);
  }
}


// 7) Dynamically generate your 15 player‐summary tiles
function generatePlayerTiles() {
  const grid = document.getElementById("playerGrid");
  grid.innerHTML = "";
  const ids = Object.keys(gameData.playerStats).slice(0, 15);

  ids.forEach((pid) => {
    const stats = gameData.playerStats[pid] || {};
    const tile = document.createElement("div");
    tile.className = "player-summary";
    tile.dataset.playerId = pid;
    tile.innerHTML = `
      <div class="player-summary-header">
        <div class="player-name">${stats.name || "–"}</div>
        <div class="player-score">${stats.score ?? "0"}</div>
      </div>
      <div class="player-summary-details">
        <p>Tags: <span class="detail-tags">–</span></p>
        <p>Ratio: <span class="detail-ratio">–</span></p>
        <p>Goals: <span class="detail-goals">–</span></p>
        <p>Denies: <span class="detail-denies">–</span></p>
        <p>Active: <span class="detail-active">–</span></p>
      </div>
    `;
    grid.appendChild(tile);
  });
}

// 8) Expand‐in‐place logic for each tile
function setupTileExpansion() {
  document.querySelectorAll(".player-summary").forEach((tile) => {
    tile.addEventListener("click", () => {
      const isExp = tile.classList.toggle("expanded");
      if (!isExp) return;
      const pid = tile.dataset.playerId;
      const s = gameData.playerStats[pid] || {};
      tile.querySelector(".detail-tags").textContent = s.tags ?? "–";
      tile.querySelector(".detail-ratio").textContent = s.ratio ?? "–";
      tile.querySelector(".detail-goals").textContent = s.goals ?? "–";
      tile.querySelector(".detail-denies").textContent = s.denies ?? "–";
      tile.querySelector(".detail-active").textContent = s.active ?? "–";
    });
  });
}

// 9) Draggable YouTube modal setup
function setupDraggableModal() {
  const modal = document.getElementById("videoModal");
  const header = modal.querySelector(".modal-header");
  const closeBtn = document.getElementById("modalClose");
  const loadBtn = document.getElementById("loadButton");
  const urlInput = document.getElementById("youtubeUrl");

  modal.style.display = "none";
  let dragging = false,
    offsetX = 0,
    offsetY = 0;

  loadBtn.addEventListener("click", () => {
    const v = parseYouTubeId(urlInput.value);
    if (!v) return;
    modal.style.display = "block";
    if (player) player.loadVideoById(v);
    else
      player = new YT.Player("modalPlayer", {
        height: "315",
        width: "560",
        videoId: v,
        playerVars: { origin: location.origin },
      });
  });

  closeBtn.addEventListener("click", () => {
    modal.style.display = "none";
    if (player) player.stopVideo();
  });

  header.addEventListener("mousedown", (e) => {
    dragging = true;
    const r = modal.getBoundingClientRect();
    offsetX = e.clientX - r.left;
    offsetY = e.clientY - r.top;
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    modal.style.left = `${e.clientX - offsetX}px`;
    modal.style.top = `${e.clientY - offsetY}px`;
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.style.userSelect = "";
  });
}

// 10) Helper to extract YouTube ID
function parseYouTubeId(url) {
  const m = url.match(/(?:v=|\.be\/)([\w\-]{11})/);
  return m ? m[1] : null;
}

function seekToTime(sec) {
if (!gameData) return;
  const duration = gameData.gameDuration 
    ?? Math.max(...gameData.events.map(e => e.time));
  // clamp
  sec = Math.max(0, Math.min(sec, duration));
  currentTime = sec;

  // sync video
  if (player && typeof player.seekTo === 'function') {
    player.seekTo(sec, true);
  }

  // 1) update tiles
  updatePlayerTiles(sec);

  // 2) update team‐score list
  updateTeamScoresUI();

  // 3) update live series
  updateLiveSeries(sec);

  // 4) move cursor line
  const axis = chart.xAxis[0];
  axis.removePlotLine('cursor-line');
  axis.addPlotLine({
    id: 'cursor-line',
    value: sec,
    color: '#888',
    width: 2,
    dashStyle: 'Dash',
    zIndex: 5
  });
}

// 1) Build a per-second timeline for each team
function buildTeamTimeline(data) {
  // total game length in seconds
  const duration =
    data.gameDuration ?? Math.max(...data.events.map((e) => e.time));

  // bucket events by timestamp, remembering teamId + delta
  const eventsBySecond = {};
  data.events.forEach((ev) => {
    // figure out which team this event hits
    const teamId =
      ev.teamDelta != null
        ? ev.entity // if entity is already a team
        : data.players[ev.entity].team; // or map player→team

    if (!eventsBySecond[ev.time]) eventsBySecond[ev.time] = [];
    eventsBySecond[ev.time].push({
      teamId,
      delta: ev.teamDelta ?? ev.delta ?? 0,
    });
  });

  // init running totals & timeline arrays
  const totals = {};
  const timeline = {};
  data.teams.forEach((t) => {
    totals[t.id] = 0;
    timeline[t.id] = [];
  });

  // walk each second, apply that second’s deltas, then record a point
  for (let sec = 0; sec <= duration; sec++) {
    (eventsBySecond[sec] || []).forEach((ev) => {
      totals[ev.teamId] += ev.delta;
    });
    data.teams.forEach((t) => {
      timeline[t.id].push([sec, totals[t.id]]);
    });
  }

  return timeline;
}

/** Convert hex color "#RRGGBB" to rgba() string with alpha */
function hexToRGBA(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Write the current teamScores into the HTML.
 */
function updateTeamScoresUI() {
  Object.entries(teamScores).forEach(([teamId, score]) => {
    const el = document.querySelector(
      `.team-scores li[data-team-id="${teamId}"] .team-score`
    );
    if (el) el.textContent = score;
  });
}

/**
 * Resets each “-live” series to the points up to currentTime
 */
function updateLiveSeries(currentTime) {
  const offset = gameData.teams.length;  // ghost series are first
  gameData.teams.forEach((team, idx) => {
    const pts = (teamFullTimeline[team.id] || [])
      .filter(pt => pt[0] <= currentTime);
    // Replace the live series’ data in-place
    chart.series[offset + idx].setData(pts, false);
  });
  chart.redraw();  // batch redraw after all series updated
}


// 11) Start everything once the DOM is ready
document.addEventListener("DOMContentLoaded", loadGameData);
