import { hexToRGBA, formatTime, getGameDuration, getPlayerHighlightColor, normaliseText } from "./utils.js";
import { jumpTo } from "./replayHandler.js";
import { state } from "./state.js";
import { COMPACT_LAYOUT_QUERY, SHORT_LANDSCAPE_QUERY } from "./config.js";

const BASE_MARKER_DESKTOP = {
    offset: 12,
    size: 8,
    labelOffset: 6,
    labelFontSize: "12px",
};
const BASE_MARKER_SHORT_LANDSCAPE = {
    offset: 8,
    size: 4,
    labelOffset: 4,
    labelFontSize: "9px",
};

function getBaseDisplayName(base, team, fallback = "?") {
    const colorName = ["none", "???"].includes(normaliseText(base?.colorName))
        ? ""
        : base?.colorName;
    const name = base?.name ||
        (colorName ? `${colorName} Base` : "") ||
        (team?.name ? `${team.name} Base` : "") ||
        fallback;
    return String(name).trim().replace(/\s+base$/i, "");
}

function getBaseMarkerDisplayName(base, team, fallback = "?") {
    const compColourMatch = String(team?.colorName || "").trim().match(/^comp\s+(.+)$/i);
    if (compColourMatch?.[1]) return compColourMatch[1].trim();

    const teamName = String(team?.name || "").trim().replace(/\s+team$/i, "");
    if (teamName) return teamName;

    const teamId = String(team?.id || "").trim();
    if (teamId && !/^\d+$/.test(teamId)) return teamId;

    return getBaseDisplayName(base, team, fallback);
}

function findBaseByTarget(activeBases, target) {
    const targetId = normaliseText(target);
    if (!targetId) return null;
    const directMatch = (activeBases || []).find(
        (base) => {
            const entityId = normaliseText(base?.entityId);
            return entityId && entityId === targetId;
        }
    );
    if (directMatch) return directMatch;
    const teamMatches = (activeBases || []).filter(
        (base) => normaliseText(base?.team) === targetId
    );
    return teamMatches.length === 1 ? teamMatches[0] : null;
}

function buildBaseDestroyPoints(data) {
    const totals = {};
    const teamsById = {};
    const baseColorsByEntityId = {};

    data.teams.forEach((t) => {
        totals[t.id] = 0;
        teamsById[normaliseText(t.id)] = t;
    });

    (data.active_bases || []).forEach((base) => {
        const id = normaliseText(base?.entityId);
        if (!id) return;
        const team = teamsById[normaliseText(base?.team)];
        // Base-destroy markers represent the owning Comp team, not the
        // physical base identity. The Comp team's colour takes precedence.
        if (team?.color) baseColorsByEntityId[id] = team.color;
        else if (base?.color) baseColorsByEntityId[id] = base.color;
    });

    const sortedEvents = [...data.events].sort((a, b) => a.time - b.time);

    return sortedEvents.reduce((acc, ev) => {
        const player = data.players[ev.entity];
        if (!player) return acc;

        const teamId = player.team;
        const normalizedTeamId = normaliseText(teamId);
        if (!(teamId in totals)) return acc;

        const delta = ev.delta ?? 0;
        totals[teamId] += delta;

        if (ev.type === "base destroy") {
            const attackerTeam = teamsById[normalizedTeamId];
            const targetId = normaliseText(ev.target);
            const attackerName = attackerTeam?.name || teamId;
            const targetBase = findBaseByTarget(data.active_bases, targetId);
            const targetTeam = teamsById[normaliseText(targetBase?.team)];
            const targetBaseName = getBaseMarkerDisplayName(targetBase, targetTeam, targetId || "?");
            const targetLabel = targetBaseName.charAt(0).toUpperCase();
            const targetColor = targetTeam?.color || baseColorsByEntityId[targetId] ||
                targetBase?.color || "#ffffff";

            acc.push({
                x: ev.time,
                y: totals[teamId],
                color: attackerTeam?.color || "#ffffff",
                attackerTeamId: teamId,
                playerName: player.name || player.id || ev.entity,
                attackerTeamName: attackerName,
                targetBaseName,
                targetBaseLabel: targetLabel,
                targetColor,
            });
        }

        return acc;
    }, []);
}

function filterBaseDestroySeries(selectedSet) {
    if (!state.chart) return;
    const series = state.chart.get("base-destroys");
    if (!series) return;
    const allPoints = state.chart.baseDestroyAllPoints || [];
    const filtered =
        selectedSet && selectedSet.size
        ? allPoints.filter((pt) => !selectedSet.has(pt.attackerTeamId))
        : allPoints;
    // clone objects
    const payload = filtered.map((pt) => ({ ...pt }));
    series.setData(payload, false, false);
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
    filterBaseDestroySeries(selectedSet);
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

export function setHiddenTeams(teamIds = null) {
    state.hiddenTeams = teamIds && teamIds.size ? new Set(teamIds) : null;
    applyTeamSeriesVisibility(state.hiddenTeams);
}

export function buildPlayerTimelines(data) {
    const duration = Math.floor(getGameDuration(data));

    // Bucket all player deltas by second
    const buckets = {};
    const playerIds = Object.keys(data.players);
    playerIds.forEach((pid) => (buckets[pid] = {}));
    data.events.forEach((ev) => {
        const pid = ev.entity;
        if (!(pid in buckets)) return;
        // floor to whole‐second bucket:
        const sec = Math.floor(ev.time);
        const d = ev.delta ?? 0;
        buckets[pid][sec] = (buckets[pid][sec] || 0) + d;
    });

    // Walk each second and build cumulative timeline for each player
    const timelines = {};
    const totals = {};
    playerIds.forEach((pid) => {
        totals[pid] = 0;
        timelines[pid] = [[0, 0]]; // start at 0
    });

    for (let sec = 1; sec <= duration; sec++) {
        playerIds.forEach((pid) => {
        if (buckets[pid][sec]) {
            totals[pid] += buckets[pid][sec];
        }
        timelines[pid].push([sec, totals[pid]]);
        });
    }

    return timelines;
}

export function updatePlayerSeriesDisplay(redraw = true) {
    if (!state.gameData || !state.gameData.players) return;
    const compactMarkers = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
    // 1) Add missing series for every selected pid
    state.selectedPlayers.forEach((pid) => {
        if (!state.gameData.players[pid]) return;
        const sid = pid + "-player";
        const playerSeries = state.chart.get(sid);
        if (!playerSeries) {
        state.chart.addSeries({
            id: sid,
            name: state.gameData.players[pid].name,
            data: state.playerTimelines[pid] || [[0, 0]],
            color: getPlayerHighlightColor(pid),
            dashStyle: "ShortDot",
            marker: { enabled: false },
            zIndex: 4,
        }, false);
        } else {
        playerSeries.setData(state.playerTimelines[pid] || [[0, 0]], false, false);
        }

        const tagSeriesId = pid + "-tags";
        const color = getPlayerHighlightColor(pid);
        const tagPoints = (state.playerEvents?.[pid] || [])
            .filter((ev) => ev.type === "tag")
            .map((ev) => {
                const timeline = state.playerTimelines[pid] || [[0, 0]];
                const scorePoint = timeline[Math.min(Math.floor(ev.time), timeline.length - 1)];
                const target = state.gameData.players?.[ev.target];
                return {
                    x: ev.time,
                    y: scorePoint?.[1] || 0,
                    targetName: target?.name || ev.target || "Unknown player",
                };
            });
        const tagSeries = state.chart.get(tagSeriesId);
        if (!tagSeries) {
        state.chart.addSeries({
            id: tagSeriesId,
            type: "scatter",
            name: `${state.gameData.players[pid].name} tags`,
            data: tagPoints,
            color,
            marker: {
                enabled: true,
                symbol: "circle",
                radius: compactMarkers ? 2.5 : 3,
                fillColor: color,
                lineColor: "#ffffff",
                lineWidth: 1,
                states: { hover: { enabled: true, radius: compactMarkers ? 4 : 5 } },
            },
            showInLegend: false,
            zIndex: 6,
        }, false);
        } else {
        tagSeries.setData(tagPoints, false, false);
        }

        const playerTimeline = state.playerTimelines[pid] || [[0, 0]];
        const baseDestroyPoints = (state.playerEvents?.[pid] || [])
            .filter((ev) => ev.type === "base destroy")
            .map((ev) => {
                const base = findBaseByTarget(state.gameData.active_bases, ev.target);
                const team = state.gameData.teams?.find((item) => String(item.id) === String(base?.team));
                return {
                    x: ev.time,
                    y: playerTimeline[Math.min(Math.floor(ev.time), playerTimeline.length - 1)]?.[1] || 0,
                    color: team?.color || base?.color || "#ffb347",
                    targetBaseName: getBaseMarkerDisplayName(base, team, ev.target),
                };
            });
        const baseDestroySeries = state.chart.get(`${pid}-base-destroys`);
        if (baseDestroySeries) {
            baseDestroySeries.setData(baseDestroyPoints, false, false);
        } else {
            state.chart.addSeries({
                id: `${pid}-base-destroys`,
                type: "scatter",
                showInLegend: false,
                zIndex: 7,
                name: `${state.gameData.players[pid].name} base destroys`,
                marker: {
                    enabled: true,
                    symbol: "diamond",
                    radius: compactMarkers ? 4 : 5,
                    lineColor: "#ffffff",
                    lineWidth: 1,
                    states: { hover: { enabled: true, radius: compactMarkers ? 6 : 7 } },
                },
                data: baseDestroyPoints,
            }, false);
        }
    });

    // 2) Remove series for any pid not selected
    Object.keys(state.playerTimelines).forEach((pid) => {
        if (!state.selectedPlayers.has(pid)) {
        const sid = pid + "-player";
        const s = state.chart.get(sid);
        if (s) s.remove(false);
        const tagSeries = state.chart.get(pid + "-tags");
        if (tagSeries) tagSeries.remove(false);
        const baseDestroySeries = state.chart.get(pid + "-base-destroys");
        if (baseDestroySeries) baseDestroySeries.remove(false);
        }
    });

    updatePlayerStatusBands();
    if (redraw) state.chart.redraw();
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
    if (![plotLeft, plotTop, plotWidth, plotHeight].every(Number.isFinite) ||
        plotWidth <= 0 || plotHeight <= 0) return;
    const clip = chart.renderer.clipRect(plotLeft, plotTop, plotWidth, plotHeight);
    group.clip(clip);
    const pids = Array.from(state.selectedPlayers);
    const bandHeight = plotHeight / pids.length;
    const stripWidth = 4;
    const deadColor = "rgba(255, 80, 80, 0.18)";
    const aliveColor = "rgba(80, 255, 140, 0.08)";
    const reloadColor = "rgba(83, 216, 251, 0.18)";

    pids.forEach((pid, idx) => {
        const y = plotTop + idx * bandHeight;
        const series = chart.get(`${pid}-player`);
        let playerColor = series?.color;
        if (!playerColor) {
            const name = state.gameData?.players?.[pid]?.name || pid || "";
            let hash = 0;
            for (let i = 0; i < name.length; i++) {
                hash = (hash * 31 + name.charCodeAt(i)) | 0;
            }
            playerColor = `hsl(${Math.abs(hash) % 360}, 70%, 60%)`;
        }

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
            if (!Number.isFinite(x1) || !Number.isFinite(x2)) return;
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

        // A reload is an instantaneous event, not a player state. Give it a
        // fixed-width overlay so it remains visible at normal chart scales.
        (state.playerEvents?.[pid] || [])
            .filter((ev) => ev.type === "reload")
            .forEach((ev) => pushBand(
                Math.max(0, ev.time - 0.5),
                Math.min(gameEnd, ev.time + 0.5),
                reloadColor
            ));
    });

    chart.customPlayerStatusGroup = group;
    chart.customPlayerStatusClip = clip;
}

export function updateCursorPosition(sec) {
    if (!state.chart?.xAxis?.[0] || !state.chart.customCursorGroup) return;
    const chart = state.chart;
    const x = chart.xAxis[0].toPixels(sec, false);
    if (!Number.isFinite(x)) return;

    // Playback used to translate this group while seeking positioned its
    // children absolutely. Resetting the transform gives every path one
    // coordinate system and prevents their offsets compounding after jumps.
    if (chart.customCursorGroup.translateX || chart.customCursorGroup.translateY) {
        Highcharts.stop(chart.customCursorGroup);
        chart.customCursorGroup.attr({ translateX: 0, translateY: 0 });
    }
    chart.customCursorLine?.attr({
        d: [
            "M", x, chart.plotTop,
            "L", x, chart.plotTop + chart.plotHeight - 1,
        ],
    });

    // Keep the timestamp centred over the cursor except at the plot edges, where
    // only the label shifts inward and the vertical line stays at the exact time.
    const cursorLabel = chart.customCursorLabel;
    if (cursorLabel) {
        const labelText = formatTime(sec);
        if (chart.customCursorLabelText !== labelText) {
            cursorLabel.attr({ text: labelText });
            chart.customCursorLabelText = labelText;
            chart.customCursorLabelWidth = cursorLabel.getBBox().width;
        }
        const labelWidth = chart.customCursorLabelWidth ?? cursorLabel.getBBox().width;
        const plotLeft = chart.plotLeft;
        const plotRight = plotLeft + chart.plotWidth;
        if (![labelWidth, plotLeft, plotRight].every(Number.isFinite)) return;
        const halfWidth = labelWidth / 2;
        const labelPadding = 2;
        const labelCenter = Math.min(
            plotRight - halfWidth - labelPadding,
            Math.max(plotLeft + halfWidth + labelPadding, x)
        );
        const isShortLandscape = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
        const labelY = isShortLandscape ? chart.plotTop + 10 : chart.plotTop - 2;
        if (!Number.isFinite(labelCenter) || !Number.isFinite(labelY)) return;
        cursorLabel.attr({
            x: labelCenter,
            y: labelY,
        });
    } else {
        const textEl = chart.customCursorGroup.element.querySelector("text");
        if (textEl?.firstChild) textEl.firstChild.data = formatTime(sec);
    }
}

// Empty chart for live replay
export function initLiveChart(data) {
    if (state.chart) {
        state.chart.layoutResizeObserver?.disconnect();
        if (state.chart.layoutResizeFrame) {
            cancelAnimationFrame(state.chart.layoutResizeFrame);
        }
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
            const t = e.xAxis?.[0]?.value;
            if (Number.isFinite(t)) jumpTo(t);
            },
            render: function () {
            const series = this.get("base-destroys");
            if (series) {
                const chart = this;
                const marker = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches
                    ? BASE_MARKER_SHORT_LANDSCAPE
                    : BASE_MARKER_DESKTOP;
                chart.baseDestroyOverlayGroup?.destroy();
                const overlay = chart.renderer.g().attr({ zIndex: 7 }).add();
                overlay.element.style.pointerEvents = "auto";

                series.points.forEach((point) => {
                    const {
                        plotX,
                        plotY,
                        color = "#ffffff",
                        targetBaseLabel = "",
                        targetColor = "#ffffff",
                    } = point;
                    if (!Number.isFinite(plotX) || !Number.isFinite(plotY)) return;
                    const x = chart.plotLeft + plotX;
                    const y = chart.plotTop + plotY;
                    const endY = y - marker.offset;
                    const stem = chart.renderer.path(["M", x, y, "L", x, endY]).attr({
                        stroke: color,
                        "stroke-width": 1,
                        "stroke-opacity": 0.6,
                    }).add(overlay);
                    const triangle = chart.renderer.symbol(
                        "triangle",
                        x - marker.size / 2,
                        endY - marker.size / 2,
                        marker.size,
                        marker.size
                    ).attr({
                        fill: color,
                        stroke: "#111",
                        "stroke-width": 1,
                    }).add(overlay);
                    const label = chart.renderer.text(
                        targetBaseLabel,
                        x,
                        endY - marker.labelOffset
                    ).attr({
                        align: "center",
                        zIndex: 8,
                    }).css({
                        color: targetColor,
                        fontSize: marker.labelFontSize,
                        fontWeight: "bold",
                        textOutline: "1px #000",
                    }).add(overlay);
                    [stem, triangle, label].forEach((element) => {
                        element.element.addEventListener("mouseenter", () => chart.tooltip.refresh(point));
                        element.element.addEventListener("mouseleave", () => chart.tooltip.hide());
                    });
                });
                chart.baseDestroyOverlayGroup = overlay;
            }
            updatePlayerStatusBands();
            if (this.customCursorGroup) updateCursorPosition(state.currentTime);
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
        max: Math.max(1, getGameDuration(state.gameData)),
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
        softMin: 0,
        minPadding: 0,
        startOnTick: false,
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
            const target = this.point.targetBaseName
                ? ` on ${this.point.targetBaseName} base`
                : "";
            return (
                `<span style="color:${this.point.color}">\u25B2</span> ` +
                `${formatTime(this.x)} — ` +
                `<b>${this.point.playerName}</b> (${this.point.attackerTeamName})${target}`
            );
            }

            if (id.endsWith("-tags")) {
            return (
                `<span style="color:${this.point.color}">\u25CF</span> ` +
                `${formatTime(this.x)} — <b>${this.series.name.replace(/ tags$/, "")}</b> tagged ` +
                `<b>${this.point.targetName}</b>`
            );
            }

            if (id.endsWith("-base-destroys")) {
            const target = this.point.targetBaseName ? ` destroyed ${this.point.targetBaseName} base` : " destroyed a base";
            return `${formatTime(this.x)} — <b>${this.series.name.replace(/ base destroys$/, "")}</b>${target}`;
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
        responsive: {
        rules: [{
            condition: {
                callback: () => window.matchMedia(COMPACT_LAYOUT_QUERY).matches,
            },
            chartOptions: {
                chart: {
                    spacing: [8, 4, 2, 2],
                },
                title: {
                    floating: true,
                    margin: 0,
                },
                xAxis: {
                    tickLength: 4,
                    labels: {
                        y: 10,
                        style: { fontSize: "8px" },
                    },
                },
                yAxis: {
                    title: { text: null },
                },
            },
        }],
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
        .path(["M", left, top, "L", left, top + height - 1])
        .attr({
        stroke: "#888",
        "stroke-width": 2,
        dashstyle: "Dash",
        zIndex: 5,
        })
        .add(cursorGroup);

    // Keep the label inside a short landscape plot so it cannot be vertically clipped,
    // without increasing the spacing reserved above the chart.
    const isShortLandscapeTimeline = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
    const cursorLabel = chart.renderer
        .text("0:00", left, isShortLandscapeTimeline ? top + 10 : top - 2)
        .attr({ align: "center", zIndex: 6 })
        .css({
            color: "#fff",
            fontWeight: "bold",
            fontSize: "10px",
            textOutline: isShortLandscapeTimeline ? "1px #1e1e1e" : "none",
        })
        .add(cursorGroup);

    chart.customCursorGroup = cursorGroup;
    chart.customCursorLine = cursorLine;
    chart.customCursorLabel = cursorLabel;

    const hoverGroup = chart.renderer.g().attr({ zIndex: 6 }).add();
    const hoverLine = chart.renderer
        .path(["M", left, top, "L", left, top + height - 1])
        .attr({
        stroke: "rgba(136, 136, 136, 0.5)",
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
    const desktopHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    let activeTouchPointer = null;
    const updateHover = (event) => {
        const pointer = chart.pointer.normalize(event);
        const t = chart.xAxis[0].toValue(pointer.chartX, false);
        const x = chart.xAxis[0].toPixels(t, false);
        if (x < chart.plotLeft || x > chart.plotLeft + chart.plotWidth) {
            hoverGroup.hide();
            return;
        }
        const currentTop = chart.plotTop;
        hoverLine.attr({
            d: ["M", x, currentTop, "L", x, currentTop + chart.plotHeight - 1],
        });
        hoverLabel.attr({ text: formatTime(t), x, y: currentTop + 10 });
        hoverGroup.show();
    };
    hoverGroup.hide();
    chart.container.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse") return;
        activeTouchPointer = event.pointerId;
        updateHover(event);
    });
    chart.container.addEventListener("pointermove", (event) => {
        if ((event.pointerType === "mouse" && desktopHover) || event.pointerId === activeTouchPointer) {
            updateHover(event);
        }
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((type) => {
        chart.container.addEventListener(type, (event) => {
            if (event.pointerType === "mouse" && type !== "pointerleave") return;
            if (event.pointerType !== "mouse" && event.pointerId !== activeTouchPointer) return;
            activeTouchPointer = null;
            hoverGroup.hide();
        });
    });

    // Player tiles are inserted after Highcharts initializes, which can change
    // the flex height without producing a window resize event.
    if (typeof ResizeObserver !== "undefined") {
        const resizeChart = () => {
            const width = Math.round(chart.renderTo?.clientWidth || 0);
            const height = Math.round(chart.renderTo?.clientHeight || 0);
            if (!width || !height ||
                (Math.abs(chart.chartWidth - width) < 2 && Math.abs(chart.chartHeight - height) < 2)) {
                return;
            }
            if (chart.layoutResizeFrame) cancelAnimationFrame(chart.layoutResizeFrame);
            chart.layoutResizeFrame = requestAnimationFrame(() => {
                chart.layoutResizeFrame = null;
                if (!chart.renderTo) return;
                chart.setSize(width, height, false);
                if (state.chart === chart) updateCursorPosition(state.currentTime);
            });
        };
        chart.layoutResizeObserver = new ResizeObserver(resizeChart);
        chart.layoutResizeObserver.observe(chart.renderTo);
        chart.layoutResizeFrame = requestAnimationFrame(resizeChart);
    }

    applyTeamSeriesVisibility(state.hiddenTeams);
    updatePlayerStatusBands();
    return chart;
}

/**
 * Resets each “-live” series to the points up to currentTime
 */
export function updateLiveSeries(inCurrentTime) {
    if (!state.chart || !state.gameData?.teams) return;
    const offset = state.gameData.teams.length; // ghost series are first
    state.gameData.teams.forEach((team, idx) => {
        const pts = buildVisibleLivePoints(state.teamFullTimeline[team.id] || [], inCurrentTime);
        // Replace the live series’ data in-place
        state.chart.series[offset + idx]?.setData(pts, false, false);
    });
    state.chart.redraw(); // batch redraw after all series updated
}

function buildVisibleLivePoints(points, currentTime) {
    const time = Math.max(0, Number(currentTime) || 0);
    const visible = (points || []).filter((pt) => pt[0] <= time);
    const last = visible[visible.length - 1];
    if (!last) return time > 0 ? [[0, 0], [time, 0]] : [[0, 0]];
    if (last[0] < time) return [...visible, [time, last[1]]];
    return visible;
}

export function refreshLiveChartData(data, currentTime) {
    const chart = state.chart;
    if (!chart || !data) return false;

    const existingTeamIds = new Set(
        chart.series
            .map((series) => series.options?.id || "")
            .filter((id) => id.endsWith("-live"))
            .map((id) => id.slice(0, -"live".length - 1))
    );
    const nextTeamIds = new Set((data.teams || []).map((team) => team.id));
    if (
        existingTeamIds.size !== nextTeamIds.size ||
        [...nextTeamIds].some((id) => !existingTeamIds.has(id))
    ) {
        return false;
    }

    state.teamFullTimeline = buildTeamTimeline(data);
    state.playerTimelines = buildPlayerTimelines(data);

    const duration = Math.max(1, getGameDuration(data));
    if (chart.xAxis?.[0]) {
        chart.xAxis[0].update({ max: duration }, false);
    }

    data.teams.forEach((team) => {
        const ghost = chart.get(`${team.id}-ghost`);
        const live = chart.get(`${team.id}-live`);
        const fullPoints = state.teamFullTimeline[team.id] || [];
        if (ghost) ghost.setData(fullPoints, false, false);
        if (live) live.setData(buildVisibleLivePoints(fullPoints, currentTime), false, false);
    });

    const baseDestroyPoints = buildBaseDestroyPoints(data);
    chart.baseDestroyAllPoints = baseDestroyPoints.map((pt) => ({ ...pt }));
    filterBaseDestroySeries(state.hiddenTeams);
    updatePlayerSeriesDisplay(false);
    return true;
}

// Build per second timeline for a team.
export function buildTeamTimeline(data) {
    const teams = Array.isArray(data?.teams) ? data.teams : [];
    const events = Array.isArray(data?.events) ? data.events : [];
    const players = data?.players || {};
    const timeline = Object.fromEntries(teams.map((team) => [team.id, []]));
    const totals = Object.fromEntries(teams.map((team) => [team.id, 0]));

    const sortedEvents = [...events].sort((a, b) => a.time - b.time);

    sortedEvents.forEach((ev) => {
        const player = players[ev.entity];
        if (!player) return;

        const teamId = player.team;
        if (!Object.hasOwn(timeline, teamId)) return;
        totals[teamId] += ev.delta ?? 0;
        timeline[teamId].push([ev.time, totals[teamId]]);
    });

    return timeline;
}
