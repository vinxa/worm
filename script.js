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
let teamFullTimeline = {}; // will hold per‐second arrays from buildTeamTimeline

// 3) YouTube API ready callback
function onYouTubeIframeAPIReady() {
  console.log("YouTube IFrame API ready");
}

function handleSkip(delta) {
  // a) If a replay is running, cancel every scheduled tick:
  if (isPlaying) {
    replayTimeouts.forEach((id) => clearTimeout(id));
    replayTimeouts = [];
  }

  // b) Compute & clamp the new time:
  const maxTime =
    gameData.gameDuration ?? Math.max(...gameData.events.map((e) => e.time));
  const newTime = Math.min(maxTime, Math.max(0, currentTime + delta));

  // c) Seek all UI & chart to newTime:
  seekToTime(newTime);

  // d) If we were playing, start a fresh replay from newTime
  if (isPlaying) {
    playReplay(chart, gameData, 1, replayTimeouts, currentTime);
  }
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

function updateCursorPosition(sec) {
  const axis = chart.xAxis[0];
  const x = axis.toPixels(sec, false);
  const dx = x - chart.plotLeft;

  // move the whole group without animation
  chart.customCursorGroup.attr({ translateX: dx });

  // update its label text
  const textEl = chart.customCursorGroup.element.querySelector("text");
  textEl.firstChild.data = formatTime(sec);
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
        replayTimeouts.forEach((id) => clearTimeout(id));
        replayTimeouts = [];
        // start replay, passing our array to fill with timeout IDs
        playReplay(chart, gameData, 1, replayTimeouts, currentTime);
        if (player && typeof player.playVideo === "function") {
          player.playVideo();
        }
      } else {
        isPlaying = false;
        btn.textContent = "▶"; // back to play icon
        if (player && typeof player.pauseVideo === "function") {
          player.pauseVideo();
        }
        // cancel pending events
        replayTimeouts.forEach((id) => clearTimeout(id));
      }
    });

    document
      .getElementById("rewindButton")
      .addEventListener("click", () => handleSkip(-15));
    document
      .getElementById("forwardButton")
      .addEventListener("click", () => handleSkip(+15));
  } catch (err) {
    console.error("Failed to load game data:", err);
  }
}

/**
 * From data.events, build a map of teamId → { sec: totalDeltaAtThatSec, … }
 */
function bucketTeamDeltas(data) {
  const buckets = {};
  data.teams.forEach((t) => (buckets[t.id] = {}));

  data.events.forEach((ev) => {
    const teamId =
      ev.teamDelta != null ? ev.entity : data.players[ev.entity].team;
    const d = ev.teamDelta ?? ev.delta ?? 0;
    buckets[teamId][ev.time] = (buckets[teamId][ev.time] || 0) + d;
  });

  return buckets;
}

/**
 * Returns { teamId: [ [0,0], [1,score], [2,score], … ] }
 */
function buildTeamTimeline(data) {
  const duration =
    data.gameDuration ?? Math.max(...data.events.map((e) => e.time), 0);

  const buckets = bucketTeamDeltas(data);
  const timeline = {};
  const totals = {};

  // init
  data.teams.forEach((t) => {
    totals[t.id] = 0;
    timeline[t.id] = [];
  });

  // walk each second
  for (let sec = 0; sec <= duration; sec++) {
    data.teams.forEach((t) => {
      // apply any delta at this second
      totals[t.id] += buckets[t.id][sec] || 0;
      // record the running total
      timeline[t.id].push([sec, totals[t.id]]);
    });
  }

  return timeline;
}

// 5) Initialize an empty chart for live replay
function initLiveChart(data) {
  const fullTimeline = buildTeamTimeline(data);
  const liveSeries = data.teams.map((t) => ({
    name: t.name,
    data: [[0, 0]],
    color: t.color,
    zIndex: 5,
  }));
  const ghostSeries = data.teams.map((t) => ({
    id: t.id + "-ghost",
    name: t.name,
    data: fullTimeline[t.id],
    color: hexToRGBA(t.color, 0.4),
    enableMouseTracking: false,
    showInLegend: false,
    zIndex: 1,
  }));

  const cchart = Highcharts.chart("scoreChart", {
    chart: {
      type: "line",
      backgroundColor: "#2a2a2a",
      events: {
        click: function (e) {
          // 1) figure out the clicked time (in seconds)
          const t = Math.round(e.xAxis[0].value);

          // 2) seek to that time (updates tiles, team UI & cursor)
          seekToTime(t);

          // 3) if we're currently playing, restart playback from there
          if (isPlaying) {
            replayTimeouts.forEach((id) => clearTimeout(id));
            replayTimeouts = [];
            playReplay(chart, gameData, 1, replayTimeouts, currentTime);
          }
        },
      },
    },
    title: { text: null },
    xAxis: {
      gridLineWidth: 1,
      gridLineColor: "rgba(136, 136, 136, 0.3)",
      min: 0,
      max: gameData.gameDuration,
      tickInterval: 60,
      minorTickInterval: 0.5,
      minorTickLength: 5,
      minorGridLineWidth: 0.5,
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
      labels: { style: { color: "#ccc" } },
      plotLines: [
        {
          value: 0,
          color: "#888",
          width: 1,
          zIndex: 2,
          dashStyle: "Dash",
        },
      ],
    },
    series: [...ghostSeries, ...liveSeries],
    credits: { enabled: false },
    legend: { enabled: false, itemStyle: { color: "#eee" } },
    plotOptions: {
      series: {
        marker: { enabled: false, states: { hover: { enabled: false } } },
        stickyTracking: false,
      },
      tooltip: { snap: 5 },
    },
  });

  // grab chart internals for positioning
  const left = cchart.plotLeft;
  const top = cchart.plotTop;
  const height = cchart.plotHeight;

  const cursorGroup = cchart.renderer.g().attr({ zIndex: 5 }).add();

  // 1a) Draw a vertical line at x=0
  const cursorLine = cchart.renderer
    .path(["M", left, top, "L", left, top + height])
    .attr({
      stroke: "#888",
      "stroke-width": 2,
      dashstyle: "Dash",
      zIndex: 5,
    })
    .add(cursorGroup);

  // 1b) Draw a timestamp label just above it
  const cursorLabel = cchart.renderer
    .text("0:00", left, top - 2)
    .attr({ align: "center", zIndex: 6 })
    .css({ color: "#fff", fontWeight: "bold", fontSize: "10px" })
    .add(cursorGroup);

  cchart.customCursorGroup = cursorGroup;

  return cchart;
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
function playReplay(chart, data, rate = 1, timeouts = [], startSec = 0) {
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
    teamScores[t.id] = 0;
  });
  while (
    eventIdx < sortedEvents.length &&
    sortedEvents[eventIdx].time < startSec
  ) {
    const ev = sortedEvents[eventIdx++];
    const teamId =
      ev.teamDelta != null ? ev.entity : data.players[ev.entity].team;
    teamScores[teamId] += ev.teamDelta ?? ev.delta ?? 0;
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
      if (!isPlaying) return;

      // ← INSERT this to keep currentTime in sync!
      currentTime = t;

      // a) apply any events whose time ≤ t
      while (
        eventIdx < sortedEvents.length &&
        sortedEvents[eventIdx].time <= t
      ) {
        const ev = sortedEvents[eventIdx++];
        const teamId =
          ev.teamDelta != null ? ev.entity : data.players[ev.entity].team;
        teamScores[teamId] += ev.teamDelta ?? ev.delta ?? 0;
      }

      // b) draw a point for each team at time = t
      const offset = data.teams.length; // ghost series first
      data.teams.forEach((team, idx) => {
        chart.series[offset + idx].addPoint(
          [t, teamScores[team.id]],
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
  const duration =
    gameData.gameDuration ?? Math.max(...gameData.events.map((e) => e.time));
  // clamp
  sec = Math.max(0, Math.min(sec, duration));
  currentTime = sec;

  // sync video
  if (player && typeof player.seekTo === "function") {
    player.seekTo(sec, true);
  }

  // 1) update tiles
  updatePlayerTiles(sec);

  // 2) update team‐score list
  updateTeamScoresUI();

  // 3) update live series
  updateLiveSeries(sec);

  // 4) move cursor line
  updateCursorPosition(currentTime);
}

// Build per second timeline for a team.
function buildTeamTimeline(data) {
  // total game length in seconds
  const duration =
    data.gameDuration ?? Math.max(...data.events.map((e) => e.time));

  // bucket events by timestamp, remembering teamId + delta
  const buckets = {};
  data.teams.forEach((t) => (buckets[t.id] = {}));
  data.events.forEach((ev) => {
    // figure out which team this event hits
    const teamId =
      ev.teamDelta != null
        ? ev.entity // if entity is already a team
        : data.players[ev.entity].team; // or map player→team
    buckets[teamId][ev.time] =
      (buckets[teamId][ev.time] || 0) + (ev.teamDelta ?? ev.delta ?? 0);
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
    data.teams.forEach((t) => {
      totals[t.id] += buckets[t.id][sec] || 0;
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
  const offset = gameData.teams.length; // ghost series are first
  gameData.teams.forEach((team, idx) => {
    const pts = (teamFullTimeline[team.id] || []).filter(
      (pt) => pt[0] <= currentTime
    );
    // Replace the live series’ data in-place
    chart.series[offset + idx].setData(pts, false);
  });
  chart.redraw(); // batch redraw after all series updated
}

/**
 * Convert an integer number of seconds to "M:SS".
 */
function formatTime(sec) {
  const total = Math.floor(sec); // drop any fractional part
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + (s < 10 ? "0" + s : s);
}

// 11) Start everything once the DOM is ready
document.addEventListener("DOMContentLoaded", loadGameData);
