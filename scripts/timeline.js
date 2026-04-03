import { hexToRGBA, formatTime, getGameDuration } from "./utils.js";
import { playReplay, seekToTime, clearTimeouts } from "./replayHandler.js";
import { state } from "./state.js";

const BASE_MARKER_OFFSET = 12;
const BASE_MARKER_SIZE = 8;

function buildBaseDestroyPoints(data) {
    const totals = {};
    const teamsById = {};
    data.teams.forEach((t) => {
        totals[t.id] = 0;
        teamsById[t.id] = t;
    });

    const sortedEvents = [...data.events].sort((a, b) => a.time - b.time);

    return sortedEvents.reduce((acc, ev) => {
        const player = data.players[ev.entity];
        if (!player) return acc;

        const teamId = player.team;
        if (!(teamId in totals)) return acc;

        const delta = ev.delta ?? 0;
        totals[teamId] += delta;

        if (ev.type === "base destroy") {
            const attackerTeam = teamsById[teamId];
            const targetId = (ev.target || "").toLowerCase();
            const targetTeam = teamsById[targetId];
            const attackerName = attackerTeam?.name || teamId;
            const targetName = targetTeam?.name || ev.target || "";
            const targetLabel = (targetName.trim() || "?").charAt(0).toUpperCase();
            const targetColor = targetTeam?.color || "#ffffff";

            acc.push({
                x: ev.time,
                y: totals[teamId],
                color: attackerTeam?.color || "#ffffff",
                attackerTeamId: teamId,
                playerName: player.name || player.id || ev.entity,
                attackerTeamName: attackerName,
                targetTeamName: targetName,
                teamLabel: targetLabel,
                targetColor,
            });
        }

        return acc;
    }, []);
}

function drawBaseDestroyOverlays(chart) {
    const series = chart.get("base-destroys");
    if (!series) return;

    if (chart.baseDestroyOverlayGroup) chart.baseDestroyOverlayGroup.destroy();

    const g = chart.renderer.g().attr({ zIndex: 7 }).add();
    g.element.style.pointerEvents = "auto";

    const addTooltipHandlers = (el, point) => {
        if (!el || !el.element) return;
        el.element.addEventListener("mouseenter", () => chart.tooltip.refresh(point));
        el.element.addEventListener("mouseleave", () => chart.tooltip.hide());
    };

    series.points.forEach((pt) => {
        const { plotX, plotY, color = "#ffffff", teamLabel = "", targetColor = "#ffffff" } = pt;
        if (!Number.isFinite(plotX) || !Number.isFinite(plotY)) return;
        const x = chart.plotLeft + plotX;
        const y = chart.plotTop + plotY;
        const endY = y - BASE_MARKER_OFFSET;
        const labelColor = targetColor;

        const stem = chart.renderer
        .path(["M", x, y, "L", x, endY])
        .attr({
            stroke: color,
            "stroke-width": 1,
            "stroke-opacity": 0.6,
        })
        .add(g);

        const tri = chart.renderer
        .symbol(
            "triangle",
            x - BASE_MARKER_SIZE / 2,
            endY - BASE_MARKER_SIZE / 2,
            BASE_MARKER_SIZE,
            BASE_MARKER_SIZE
        )
        .attr({
            fill: color,
            stroke: "#111",
            "stroke-width": 1,
        })
        .add(g);

        const lbl = chart.renderer
        .text(teamLabel, x, endY - 6)
        .attr({ align: "center", zIndex: 8 })
        .css({ color: labelColor, fontSize: "12px", fontWeight: "bold", textOutline: "1px #000" })
        .add(g);

        addTooltipHandlers(stem, pt);
        addTooltipHandlers(tri, pt);
        addTooltipHandlers(lbl, pt);
    });

    chart.baseDestroyOverlayGroup = g;
}

function filterBaseDestroySeries(selectedSet, chart = state.chart) {
    if (!chart) return;
    const series = state.chart.get("base-destroys");
    if (!series) return;
    const allPoints = state.chart.baseDestroyAllPoints || [];
    const filtered =
        selectedSet && selectedSet.size
        ? allPoints.filter((pt) => !selectedSet.has(pt.attackerTeamId))
        : allPoints;
    // clone objects
    const payload = filtered.map((pt) => ({ ...pt }));
    series.setData(payload, false);
}

function applyTeamSeriesVisibility(selectedSet) {
    const chart = state.chart;
    const gameData = state.gameData;
    if (!chart || !gameData) return;
    const showAll = !selectedSet || selectedSet.size === 0;
    gameData.teams.forEach((team) => {
        const live = chart.get(`${team.id}-live`);
        const ghost = chart.get(`${team.id}-ghost`);
        const hidden = selectedSet ? selectedSet.has(team.id) : false;
        const visible = showAll || !hidden;
        if (live) live.setVisible(visible, false);
        if (ghost) ghost.setVisible(visible, false);
    });
    filterBaseDestroySeries(selectedSet, chart);
    chart.redraw();
}

export function toggleTeamVisibility(teamId = null) {
    if (!state.hiddenTeams) state.hiddenTeams = new Set();

    if (!teamId) {
        state.hiddenTeams.clear();
        state.hiddenTeams = null;
    } else {
        if (state.hiddenTeams.has(teamId)) {
        state.hiddenTeams.delete(teamId);
        } else {
        state.hiddenTeams.add(teamId);
        }
        if (state.hiddenTeams.size === 0) {
        state.hiddenTeams = null; // fall back to show all
        }
    }
    applyTeamSeriesVisibility(state.hiddenTeams);
}

export function buildPlayerTimelines(data) {
    // 1) Determine duration (in whole seconds)
    const duration = Math.floor(getGameDuration(data));

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

/* function togglePlayerSeries(pid) {
    const sid = pid + "-player";
    const existing = chart.get(sid);
    if (existing) {
        existing.remove();
        return;
    }
    const tl = playerTimelines[pid] || [];
    chart.addSeries({
        id: sid,
        name: state.gameData.players[pid].name,
        data: tl,
        dashStyle: "ShortDot",
        marker: { enabled: false },
        zIndex: 6,
    });
} */

export function updatePlayerSeriesDisplay() {
    if (!state.gameData || !state.gameData.players) return;
    // 1) Add missing series for every selected pid
    state.selectedPlayers.forEach((pid) => {
        if (!state.gameData.players[pid]) return;
        const sid = pid + "-player";
        if (!state.chart.get(sid)) {
        state.chart.addSeries({
            id: sid,
            name: state.gameData.players[pid].name,
            data: state.playerTimelines[pid] || [[0, 0]],
            dashStyle: "ShortDot",
            marker: { enabled: false },
            zIndex: 4,
        });
        }
    });

    // 2) Remove series for any pid not selected
    Object.keys(state.playerTimelines).forEach((pid) => {
        if (!state.selectedPlayers.has(pid)) {
        const sid = pid + "-player";
        const s = state.chart.get(sid);
        if (s) s.remove();
        }
    });

    updatePlayerStatusBands();
}

function updatePlayerStatusBands() {
    const chart = state.chart;
    if (!chart) return;
    const axis = chart.xAxis[0];
    if (!axis) return;

    if (chart.customPlayerStatusGroup) {
        chart.customPlayerStatusGroup.destroy();
        chart.customPlayerStatusGroup = null;
    }
    if (chart.customPlayerStatusClip) {
        chart.customPlayerStatusClip.destroy();
        chart.customPlayerStatusClip = null;
    }

    if (!state.selectedPlayers || state.selectedPlayers.size === 0) return;

    const gameEnd = getGameDuration(state.gameData);
    if (gameEnd <= 0) return;

    const group = chart.renderer.g().attr({ zIndex: 0 }).add(chart.seriesGroup);
    const plotLeft = chart.plotLeft;
    const plotTop = chart.plotTop;
    const plotWidth = chart.plotWidth;
    const plotHeight = chart.plotHeight;
    const clip = chart.renderer.clipRect(plotLeft, plotTop, plotWidth, plotHeight);
    group.clip(clip);
    const pids = Array.from(state.selectedPlayers);
    const bandHeight = plotHeight / pids.length;
    const stripWidth = 4;
    const deadColor = "rgba(255, 80, 80, 0.18)";
    const aliveColor = "rgba(80, 255, 140, 0.08)";

    const getPlayerColor = (pid) => {
        const series = chart.get(`${pid}-player`);
        if (series && series.color) return series.color;
        const name = state.gameData?.players?.[pid]?.name || pid || "";
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = (hash * 31 + name.charCodeAt(i)) | 0;
        }
        const hue = Math.abs(hash) % 360;
        return `hsl(${hue}, 70%, 60%)`;
    };

    pids.forEach((pid, idx) => {
        const y = plotTop + idx * bandHeight;
        const playerColor = getPlayerColor(pid);

        chart.renderer
            .rect(plotLeft, y, stripWidth, bandHeight)
            .attr({ fill: playerColor, zIndex: 2 })
            .add(group);
        chart.renderer
            .rect(plotLeft + plotWidth - stripWidth, y, stripWidth, bandHeight)
            .attr({ fill: playerColor, zIndex: 2 })
            .add(group);

        const events = (state.playerEvents?.[pid] || [])
            .filter((ev) => ev.type === "deactivated" || ev.type === "reactivated")
            .sort((a, b) => a.time - b.time);

        let status = "alive";
        let lastTime = 0;

        const pushBand = (from, to, color) => {
            if (to <= from) return;
            const x1 = axis.toPixels(from, false);
            const x2 = axis.toPixels(to, false);
            const width = Math.max(0, x2 - x1);
            if (width <= 0) return;
            chart.renderer
                .rect(x1, y, width, bandHeight)
                .attr({ fill: color, zIndex: 1 })
                .add(group);
        };

        events.forEach((ev) => {
            const t = ev.time;
            if (status === "alive" && ev.type === "deactivated") {
                pushBand(lastTime, t, aliveColor);
                status = "dead";
                lastTime = t;
            } else if (status === "dead" && ev.type === "reactivated") {
                pushBand(lastTime, t, deadColor);
                status = "alive";
                lastTime = t;
            }
        });

        if (status === "alive") {
            pushBand(lastTime, gameEnd, aliveColor);
        } else {
            pushBand(lastTime, gameEnd, deadColor);
        }
    });

    chart.customPlayerStatusGroup = group;
    chart.customPlayerStatusClip = clip;
}

export function updateCursorPosition(sec) {
    const axis = state.chart.xAxis[0];
    const x = axis.toPixels(sec, false);
    const dx = x - state.chart.plotLeft;

    // move the whole group without animation
    state.chart.customCursorGroup.attr({ translateX: dx });

    // update its label text
    const textEl = state.chart.customCursorGroup.element.querySelector("text");
    textEl.firstChild.data = formatTime(sec);
}

// Empty chart for live replay
export function initLiveChart(data) {
    if (state.chart) {
        state.chart.destroy();
        state.chart = null;
    }

    const fullTimeline = buildTeamTimeline(data);
    const baseDestroyPoints = buildBaseDestroyPoints(data);
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
    const baseDestroySeries = {
        id: "base-destroys",
        type: "scatter",
        name: "Base destroyed",
        data: baseDestroyPoints,
        color: "#ffffff",
        marker: {
            enabled: true,
            symbol: "circle",
            radius: 6,
            lineWidth: 0,
            fillOpacity: 0,
            fillColor: "rgba(0,0,0,0)",
            lineColor: "rgba(0,0,0,0)",
            states: {
                hover: {
                    enabled: true,
                    radius: 7,
                    lineWidth: 0,
                    fillOpacity: 0,
                    fillColor: "rgba(0,0,0,0)",
                    lineColor: "rgba(0,0,0,0)",
                    halo: false,
                },
            },
        },
        dataLabels: { enabled: false },
        showInLegend: false,
        enableMouseTracking: true,
        zIndex: 7,
    };

    const chart = Highcharts.chart("scoreChart", {
        chart: {
        type: "line",
        backgroundColor: "#1E1E1E",
        events: {
            click: function (e) {
            // 1) figure out the clicked time (in seconds)
            const t = Math.round(e.xAxis[0].value);

            // 2) seek to that time (updates tiles, team UI & cursor)
            seekToTime(t);

            // 3) if we're currently playing, restart playback from there
            if (state.isPlaying) {
                clearTimeouts();
                playReplay(chart, state.gameData, state.playbackRate, state.replayTimeouts, state.currentTime);
            }
            },
            render: function () {
            drawBaseDestroyOverlays(this);
            updatePlayerStatusBands();
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
        max: getGameDuration(state.gameData),
        tickInterval: 60,
        minorTickInterval: 0.1,
        minorTickLength: 5,
        minorGridLineWidth: 0.1,
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
        series: [...ghostSeries, ...liveSeries, baseDestroySeries],
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
            const id = this.series.options.id || "";
            if (id === "base-destroys") {
            const target = this.point.targetTeamName
                ? ` on ${this.point.targetTeamName} base`
                : "";
            return (
                `<span style="color:${this.point.color}">\u25B2</span> ` +
                `${formatTime(this.x)} — ` +
                `<b>${this.point.playerName}</b> (${this.point.attackerTeamName})${target}`
            );
            }

            const sec = this.x;
            const isLive = id.endsWith("-live");
            const isGhost = id.endsWith("-ghost");

            // before the playhead, only live series tooltips:
            if (sec <= state.currentTime && !isLive) return false;
            // after the playhead, only ghost series tooltips:
            if (sec > state.currentTime && !isGhost) return false;

            // otherwise show the default‐looking Y-only tooltip
            return (
            `<span style="color:${this.point.color}">\u25CF</span> ` +
            `${this.series.name}: <b>${this.y}</b>`
            );
        },
        },
    });

    // keep an immutable copy for filtering toggles
    chart.baseDestroyAllPoints = baseDestroyPoints.map((pt) => ({ ...pt }));
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

    // HOVER LINE (desktop only)
    if (window.matchMedia("(pointer:fine)").matches) {
        const hoverGroup = chart.renderer.g().attr({ zIndex: 6 }).add();
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
            .text("", left, top - 5)
            .attr({ align: "center", zIndex: 7 })
            .css({ color: "#ddddddff", fontWeight: "bold", fontSize: "10px", textOutline: "1px #2A2A2A" })
            .add(hoverGroup);
        hoverGroup.hide();

        chart.container.addEventListener("mousemove", (e) => {
            const cbb = chart.container.getBoundingClientRect();
            const chartX = e.clientX - cbb.left;
            const t = chart.xAxis[0].toValue(chartX);
            const x = chart.xAxis[0].toPixels(t);

            if (x >= chart.plotLeft && x <= chart.plotLeft + chart.plotWidth) {
            hoverLine.attr({ d: ["M", x, top, "L", x, top + height] });
            hoverLabel.attr({ text: formatTime(t), x: x, y: top + 10 });
            hoverGroup.show();
            } else {
            hoverGroup.hide();
            }
        });

        chart.container.addEventListener("mouseleave", () => {
            hoverGroup.hide();
        });
    }

    applyTeamSeriesVisibility(state.hiddenTeams);
    updatePlayerStatusBands();
    return chart;
}

/**
 * Resets each “-live” series to the points up to currentTime
 */
export function updateLiveSeries(inCurrentTime) {
    const offset = state.gameData.teams.length; // ghost series are first
    state.gameData.teams.forEach((team, idx) => {
        const pts = (state.teamFullTimeline[team.id] || []).filter(
        (pt) => pt[0] <= inCurrentTime
        );
        // Replace the live series’ data in-place
        state.chart.series[offset + idx].setData(pts, false);
    });
    state.chart.redraw(); // batch redraw after all series updated
}

// Build per second timeline for a team.
export function buildTeamTimeline(data) {
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
