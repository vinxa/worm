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
let teamFullTimeline = {};
let playerTimelines = {};
let selectedPlayers = new Set();

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

    const { tagsFor, tagsAgainst, ratioText, baseCount, deniesCount } =
      computePlayerStats(pid, currentTime);

    const tagsEl = tile.querySelector(".detail-tags");
    const ratioEl = tile.querySelector(".detail-ratio");
    const deniesEl = tile.querySelector(".detail-denies");

    if (tagsEl) tagsEl.textContent = `${tagsFor} – ${tagsAgainst}`; // using thin spaces
    if (ratioEl) ratioEl.textContent = ratioText;
    if (deniesEl) deniesEl.textContent = deniesCount;
    const myTeamId = gameData.players[pid].team; // e.g. "green"
    const opponents = gameData.teams
      .filter((t) => t.id !== myTeamId) // keep only other teams
      .map((t) => ({ id: t.id, color: t.color })); // get their IDs & colors
    const baseStats = computeBaseStats(pid, currentTime);
    const container = tile.querySelector(".detail-bases");

    if (container) {
      container.innerHTML = opponents
        .map(({ id, color }) => {
          // stat for this target:
          const stat = baseStats[id] || { count: 0, destroyed: false };
          return `
      <div class="base-box${stat.destroyed ? " filled" : ""}"
           style="
             border-color: ${color};
             ${stat.destroyed ? `background:${color}` : ""}
           ">
        ${stat.count}
      </div>
    `;
        })
        .join("");
    }
  });

  sortTiles();
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

    // 2) compute and store gameDuration & currentTime at the end
    const maxEvent = gameData.events.length
      ? Math.max(...gameData.events.map((e) => e.time))
      : 0;
    gameData.gameDuration = gameData.gameDuration ?? maxEvent;
    currentTime = gameData.gameDuration;

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
    playerTimelines = buildPlayerTimelines(gameData);

    // 4b) Build the 15 player tiles
    generatePlayerTiles();
    setupTileExpansion();
    setupPlayerSeriesToggles();
    colorPlayerNamesFromChart();

    // 4d) Wire up the draggable YouTube modal
    setupDraggableModal();
    seekToTime(currentTime);

    // 4e) Hook the "Play" button to start the replay
    document.getElementById("playButton").addEventListener("click", () => {
      const btn = document.getElementById("playButton");
      if (!gameData) return; // safety
      if (currentTime >= gameData.gameDuration) {
        seekToTime(0);
      }
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
        replayTimeouts.forEach((id) => clearTimeout(id));
        replayTimeouts = [];
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

    document.addEventListener("keydown", (e) => {
      switch (e.code) {
        case "Space":
          e.preventDefault();
          if (currentTime >= gameData.gameDuration) {
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
      }
    });
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
    id: t.id + "-live",
    data: [[0, 0]],
    color: t.color,
    zIndex: 5,
  }));
  const ghostSeries = data.teams.map((t) => ({
    id: t.id + "-ghost",
    name: t.name,
    data: fullTimeline[t.id],
    color: hexToRGBA(t.color, 0.4),
    enableMouseTracking: true,
    showInLegend: false,
    zIndex: 1,
  }));

  const chart = Highcharts.chart("scoreChart", {
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
    title: {
      text: "Team scores from laser tag game",
      style: {
        opacity: 0,
        fontSize: "0px",
      },
    },
    xAxis: {
      gridLineWidth: 1,
      gridLineColor: "rgba(136, 136, 136, 0.3)",
      min: 0,
      max: gameData.gameDuration,
      tickInterval: 60,
      minorTickInterval: 0.1,
      minorTickLength: 5,
      minorGridLineWidth: 0.1,
      labels: {
        style: { color: "#ccc" },
        /*************  ✨ Windsurf Command ⭐  *************/
        /**
         * Format the tick labels to show minutes:seconds.
         * @example 45 seconds → "0:45"
         * @param {number} value - the axis value at this tick
         * @returns {string} - the formatted tick label
         */
        /*******  51d804b0-7e17-4cd7-af73-d1ffc693a90c  *******/
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
    tooltip: {
      headerFormat: "",
      snap: 5,
      shared: false,
      formatter: function () {
        const sec = this.x;
        const id = this.series.options.id || "";
        const isLive = id.endsWith("-live");
        const isGhost = id.endsWith("-ghost");

        // before the playhead, only live series tooltips:
        if (sec <= currentTime && !isLive) return false;
        // after the playhead, only ghost series tooltips:
        if (sec > currentTime && !isGhost) return false;

        // otherwise show the default‐looking Y-only tooltip
        return (
          `<span style="color:${this.point.color}">\u25CF</span> ` +
          `${this.series.name}: <b>${this.y}</b>`
        );
      },
    },
  });

  // grab chart internals for positioning
  const left = chart.plotLeft;
  const top = chart.plotTop;
  const height = chart.plotHeight;

  const cursorGroup = chart.renderer.g().attr({ zIndex: 5 }).add();

  // 1a) Draw a vertical line at x=0
  const cursorLine = chart.renderer
    .path(["M", left, top, "L", left, top + height])
    .attr({
      stroke: "#888",
      "stroke-width": 2,
      dashstyle: "Dash",
      zIndex: 5,
    })
    .add(cursorGroup);

  // 1b) Draw a timestamp label just above it
  const cursorLabel = chart.renderer
    .text("0:00", left, top - 2)
    .attr({ align: "center", zIndex: 6 })
    .css({ color: "#fff", fontWeight: "bold", fontSize: "10px" })
    .add(cursorGroup);

  chart.customCursorGroup = cursorGroup;

  // HOVER LINE
  const hoverGroup = chart.renderer.g().attr({ zIndex: 4 }).add();
  const hoverLine = chart.renderer
    .path(["M", left, top, "L", left, top + height])
    .attr({
      stroke: "rgba(136, 136, 136, 0.5)", // more transparent
      "stroke-width": 2,
      dashstyle: "Dash",
      zIndex: 4,
    })
    .add(hoverGroup);
  const hoverLabel = chart.renderer
    .text("", left, top - 2)
    .attr({ align: "center", zIndex: 6 })
    .css({ color: "#fff", fontWeight: "bold", fontSize: "10px" })
    .add(hoverGroup);
  hoverGroup.hide();

  chart.container.addEventListener("mousemove", (e) => {
    const cbb = chart.container.getBoundingClientRect();
    const chartX = e.clientX - cbb.left;
    const t = chart.xAxis[0].toValue(chartX);
    const x = chart.xAxis[0].toPixels(t);

    if (x >= chart.plotLeft && x <= chart.plotLeft + chart.plotWidth) {
      hoverLine.attr({ d: ["M", x, top, "L", x, top + height] });
      hoverLabel.attr({ text: formatTime(t), x: x, y: top - 2 });
      hoverGroup.show();
    } else {
      hoverGroup.hide();
    }
  });

  chart.container.addEventListener("mouseleave", () => {
    hoverGroup.hide();
  });

  return chart;
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
      if (t >= duration) {
        // we’ve reached (or passed) the end
        isPlaying = false;
        document.getElementById("playButton").textContent = "▶";
        // clear any leftover timeouts
        replayTimeouts.forEach((id) => clearTimeout(id));
        replayTimeouts = [];
      }
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
        <p>TR: <span class="detail-ratio">–</span></p>
        <div class="detail-bases"></div>
        <p>Denies: <span class="detail-denies">–</span></p>
      </div>
    `;

    grid.appendChild(tile);
    updatePlayerTiles(tile);
  });
}

function colorPlayerNamesFromChart() {
  document.querySelectorAll(".player-summary").forEach((tile) => {
    const pid = tile.dataset.playerId;
    const player = gameData.players[pid];
    if (!player) return;

    // 1) find that player’s team
    const teamId = player.team; // e.g. 1, 2, 3

    // 2) grab the live-series for that team
    const liveSeries = chart.get(teamId + "-live");

    if (liveSeries) {
      // 3) paint the name in the exact same color
      tile.querySelector(".player-name").style.color = liveSeries.color;
    }
  });
}

// 8) Expand‐in‐place logic for each tile
function setupTileExpansion() {
  document.querySelectorAll(".player-summary").forEach((tile) => {
    tile.addEventListener("click", (e) => {
      const clickedTile = e.currentTarget;
      const pid = clickedTile.dataset.playerId;

      // toggle expanded
      const isNowExpanded = clickedTile.classList.toggle("expanded");
      if (!isNowExpanded) return; // collapse: nothing to fill
    });
  });
}

/**
 * Compute tags, tagged, ratio and base destroys for player `pid` up to time `t`.
 */
function computePlayerStats(pid, t) {
  // get all events for this player up to time t
  const evs = gameData.events.filter((ev) => ev.entity === pid && ev.time <= t);

  // count tags for / against
  let tagsFor = 0,
    tagsAgainst = 0,
    baseCount = 0,
    deniesCount = 0;
  evs.forEach((ev) => {
    if (ev.type === "tag") tagsFor++;
    else if (ev.type === "tagged") tagsAgainst++;
    else if (ev.type === "base destroy") baseCount++;
    else if (ev.type === "deny") deniesCount++;
  });

  // ratio
  const ratioText =
    tagsAgainst > 0 ? Math.round((tagsFor / tagsAgainst) * 100) + "%" : "∞";
  return { tagsFor, tagsAgainst, ratioText, baseCount, deniesCount };
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
    // Pause game replay if running.
    if (isPlaying) {
      isPlaying = false;
      document.getElementById("playButton").textContent = "▶";
      replayTimeouts.forEach((id) => clearTimeout(id));
      replayTimeouts = [];
    }
    const v = parseYouTubeId(urlInput.value);
    if (!v) return;
    modal.style.display = "block";
    if (player) {
      player.loadVideoById(v);
    } else {
      player = new YT.Player("modalPlayer", {
        height: "315",
        width: "560",
        videoId: v,
        playerVars: { origin: location.origin, disablekb: 1 },
        events: {
          onReady: () => {
            console.log("YT Player ready");
            if (player) player.seekTo(currentTime, true);
          },
          onStateChange: (e) => {
            // PLAYING → resume game
            if (e.data === YT.PlayerState.PLAYING) {
              if (!isPlaying) {
                isPlaying = true;
                document.getElementById("playButton").textContent = "❚❚";
                // restart replay from currentTime
                replayTimeouts.forEach((id) => clearTimeout(id));
                replayTimeouts = [];
                playReplay(chart, gameData, 1, replayTimeouts, currentTime);
              }
            }
            // PAUSED → pause game
            else if (e.data === YT.PlayerState.PAUSED) {
              if (isPlaying) {
                isPlaying = false;
                document.getElementById("playButton").textContent = "▶";
                replayTimeouts.forEach((id) => clearTimeout(id));
                replayTimeouts = [];
              }
            }
          },
        },
      });
    }
  });

  closeBtn.addEventListener("click", () => {
    modal.style.display = "none";
    player.destroy();
    player = null;
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
  updateTeamScoresForTime(currentTime);

  // 3) update live series
  updateLiveSeries(sec);

  // 4) move cursor line
  updateCursorPosition(currentTime);
}

// Build per second timeline for a team.
function buildTeamTimeline(data) {
  const timeline = {};

  data.teams.forEach((t) => {
    timeline[t.id] = [];
  });

  const totals = {};
  data.teams.forEach((t) => (totals[t.id] = 0));

  const sortedEvents = [...data.events].sort((a, b) => a.time - b.time);

  sortedEvents.forEach((ev) => {
    const player = data.players[ev.entity];
    if (!player) return;

    const teamId = player.team;
    totals[teamId] += ev.delta ?? 0;
    timeline[teamId].push([ev.time, totals[teamId]]);
  });

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
    const li = document.querySelector(
      `.team-scores li[data-team-id="${teamId}"]`
    );
    const name = li?.querySelector(".team-name");
    const span = li?.querySelector(".team-score");
    if (!name || !span) return;

    // update the score text
    span.textContent = score;

    // pull the chart’s live-series color
    const series = chart.get(teamId + "-live");
    const color = series ? series.color : "";

    // color the team-name, leave the score in default color
    name.style.color = color;
  });

  sortTeamScoresUI();
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

function updateTeamScoresForTime(sec) {
  // 1) zero out every team
  gameData.teams.forEach((t) => {
    teamScores[t.id] = 0;
  });

  // 2) scan every event ≤ sec and add its teamDelta/delta
  gameData.events.forEach((ev) => {
    if (ev.time <= sec) {
      const teamId =
        ev.teamDelta != null ? ev.entity : gameData.players[ev.entity].team;
      teamScores[teamId] += ev.teamDelta ?? ev.delta ?? 0;
    }
  });

  // 3) repaint the UL
  updateTeamScoresUI();
}

function buildPlayerTimelines(data) {
  // 1) Determine duration (in whole seconds)
  const duration =
    data.gameDuration != null
      ? data.gameDuration
      : Math.max(0, ...data.events.map((e) => Math.floor(e.time)));

  // 2) Bucket all player deltas by second
  const buckets = {};
  Object.keys(data.players).forEach((pid) => (buckets[pid] = {}));
  data.events.forEach((ev) => {
    const pid = ev.entity;
    if (!(pid in buckets)) return;
    // floor to whole‐second bucket:
    const sec = Math.floor(ev.time);
    const d = ev.playerDelta ?? ev.delta ?? 0;
    buckets[pid][sec] = (buckets[pid][sec] || 0) + d;
  });

  // 3) Walk each second, carrying forward each player’s total
  const timelines = {};
  const totals = {};
  Object.keys(data.players).forEach((pid) => {
    totals[pid] = 0;
    timelines[pid] = [[0, 0]]; // start at 0
  });

  for (let sec = 1; sec <= duration; sec++) {
    Object.keys(data.players).forEach((pid) => {
      if (buckets[pid][sec]) {
        totals[pid] += buckets[pid][sec];
      }
      timelines[pid].push([sec, totals[pid]]);
    });
  }

  return timelines;
}

function togglePlayerSeries(pid) {
  const sid = pid + "-player";
  const existing = chart.get(sid);
  if (existing) {
    existing.remove();
    return;
  }
  const tl = playerTimelines[pid] || [];
  chart.addSeries({
    id: sid,
    name: gameData.players[pid].name,
    data: tl,
    dashStyle: "ShortDot",
    marker: { enabled: false },
    zIndex: 6,
  });
}

function updatePlayerSeriesDisplay() {
  // 1) Add missing series for every selected pid
  selectedPlayers.forEach((pid) => {
    const sid = pid + "-player";
    if (!chart.get(sid)) {
      chart.addSeries({
        id: sid,
        name: gameData.players[pid].name,
        data: playerTimelines[pid] || [[0, 0]],
        dashStyle: "ShortDot",
        marker: { enabled: false },
        zIndex: 4,
      });
    }
  });

  // 2) Remove series for any pid not selected
  Object.keys(playerTimelines).forEach((pid) => {
    if (!selectedPlayers.has(pid)) {
      const sid = pid + "-player";
      const s = chart.get(sid);
      if (s) s.remove();
    }
  });
}

function setupPlayerSeriesToggles() {
  document.querySelectorAll(".player-summary").forEach((tile) => {
    tile.addEventListener("click", (e) => {
      const clickedTile = e.currentTarget;
      const pid = clickedTile.dataset.playerId;

      // toggle in the Set
      if (selectedPlayers.has(pid)) {
        selectedPlayers.delete(pid);
      } else {
        selectedPlayers.add(pid);
      }

      // sync chart to only show selected players
      updatePlayerSeriesDisplay();

      // if we just expanded, pull the series color and set the border
      const isExpanded = clickedTile.classList.contains("expanded");
      if (isExpanded) {
        const s = chart.get(pid + "-player");
        const c = s ? s.color : "#e2b12a";
        clickedTile.style.borderColor = c;
      } else {
        // collapsed — reset to default
        clickedTile.style.borderColor = "";
      }
    });
  });
}

/**
 * Reorders all .player-summary tiles in #playerGrid
 * by their current .player-score (desc).
 */
function sortTiles() {
  const grid = document.getElementById("playerGrid");
  const tiles = Array.from(grid.children);

  // 1) Record old positions (FLIP pre‐step)
  const oldRects = new Map();
  tiles.forEach((tile) => {
    oldRects.set(tile, tile.getBoundingClientRect());
    tile.style.transition = "";
    tile.style.transform = "";
  });

  // 2) Compute *current* team scores if you don't have them already
  //    (e.g. from updateTeamScoresForTime or similar)
  const totals = {};
  gameData.teams.forEach((team) => {
    totals[team.id] = computeTeamTotal(team.id, currentTime);
  });
  // --------------------------------------------
  // You need a `computeTeamTotal(teamId, t)` that returns
  // the sum of all ev.delta for that team up to `t`.
  // --------------------------------------------

  // 3) Build an array of team IDs sorted by descending total
  const sortedTeamIds = gameData.teams
    .map((t) => t.id)
    .sort((a, b) => (totals[b] || 0) - (totals[a] || 0));

  // 4) Group tiles by team
  const byTeam = {};
  tiles.forEach((tile) => {
    const pid = tile.dataset.playerId;
    const teamId = gameData.players[pid].team;
    (byTeam[teamId] ||= []).push(tile);
  });

  // 5) Within each team, sort players by descending score
  sortedTeamIds.forEach((teamId) => {
    const arr = byTeam[teamId] || [];
    arr.sort((a, b) => {
      const sa = +a.querySelector(".player-score").textContent;
      const sb = +b.querySelector(".player-score").textContent;
      return sb - sa;
    });
  });

  // 6) Re‐append in row order = sortedTeamIds
  sortedTeamIds.forEach((teamId) => {
    (byTeam[teamId] || []).forEach((tile) => {
      grid.appendChild(tile);
    });
  });

  // 7) FLIP animate from oldRects → new positions
  tiles.forEach((tile) => {
    const oldRect = oldRects.get(tile);
    const newRect = tile.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (!dx && !dy) return;

    tile.style.transform = `translate(${dx}px,${dy}px)`;
    tile.getBoundingClientRect(); // force reflow
    tile.style.transition = "transform 300ms ease";
    tile.style.transform = "";
    tile.addEventListener("transitionend", function handler() {
      tile.style.transition = "";
      tile.removeEventListener("transitionend", handler);
    });
  });
}

// Example helper to compute a team’s total score at time `t`:
function computeTeamTotal(teamId, t) {
  return gameData.events
    .filter(
      (ev) =>
        ev.time <= t &&
        /* event affects this team */ ((ev.teamDelta != null &&
          ev.entity === teamId) ||
          (ev.delta != null && gameData.players[ev.entity].team === teamId))
    )
    .reduce((sum, ev) => sum + (ev.teamDelta ?? ev.delta ?? 0), 0);
}

/**
 * Re-orders the .team-scores <li>s by descending team score,
 * and animates the move via FLIP.
 */
function sortTeamScoresUI() {
  const ul = document.querySelector(".team-scores");
  const items = Array.from(ul.children);

  // 1) Record old positions
  const oldRects = new Map();
  items.forEach((li) => {
    oldRects.set(li, li.getBoundingClientRect());
    li.style.transition = "";
    li.style.transform = "";
  });

  // 2) Compute current team totals
  const totals = {};
  gameData.teams.forEach((team) => {
    totals[team.id] = computeTeamTotal(team.id, currentTime);
  });

  // 3) Sort team IDs by descending total
  const sortedIds = gameData.teams
    .map((t) => t.id)
    .sort((a, b) => (totals[b] || 0) - (totals[a] || 0));

  // 4) Build new order of <li> elements
  const newOrder = sortedIds
    .map((id) => ul.querySelector(`li[data-team-id="${id}"]`))
    .filter(Boolean);

  // 5) Re-append in sorted order
  newOrder.forEach((li) => ul.appendChild(li));

  // 6) FLIP animate from old → new
  newOrder.forEach((li) => {
    const oldRect = oldRects.get(li);
    const newRect = li.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (!dx && !dy) return;

    // invert
    li.style.transform = `translate(${dx}px,${dy}px)`;
    // force reflow
    li.getBoundingClientRect();
    // play
    li.style.transition = "transform 300ms ease";
    li.style.transform = "";
    // cleanup
    li.addEventListener("transitionend", function handler() {
      li.style.transition = "";
      li.removeEventListener("transitionend", handler);
    });
  });
}

function computeBaseStats(pid, t) {
  // all base‐related events for this player up to time t
  const evs = gameData.events.filter(
    (ev) =>
      ev.entity === pid &&
      ev.time <= t &&
      (ev.type === "base hit" || ev.type === "base destroy")
  );

  const stats = {};
  evs.forEach((ev) => {
    // normalize the target to lowercase team ID:
    const tgtId = ev.target.toLowerCase(); // "Blue" → "blue"
    if (!stats[tgtId]) stats[tgtId] = { count: 0, destroyed: false };
    stats[tgtId].count++;
    if (ev.type === "base destroy") stats[tgtId].destroyed = true;
  });
  return stats;
}

// 11) Start everything once the DOM is ready
document.addEventListener("DOMContentLoaded", loadGameData);
