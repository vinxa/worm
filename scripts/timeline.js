import { hexToRGBA, formatTime } from "./utils.js";
import { playReplay, seekToTime, clearTimeouts } from "./replayHandler.js";
import { state } from "./state.js";

export function buildPlayerTimelines(data) {
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
            if (state.isPlaying) {
                clearTimeouts();
                playReplay(chart, state.gameData, 1, state.replayTimeouts, state.currentTime);
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
        max: state.gameData.gameDuration,
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
