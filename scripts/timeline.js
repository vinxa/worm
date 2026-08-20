import { buildPlayerLifeTimeline, hexToRGBA, formatTime, getGameDuration, getPlayerHighlightColor, normaliseText } from "./utils.js";
import { jumpTo } from "./replayHandler.js";
import { state } from "./state.js";
import { COMPACT_LAYOUT_QUERY, DESKTOP_TIMELINE_QUERY, SHORT_LANDSCAPE_QUERY } from "./config.js";
import { buildPlayerStatusPeriods } from "./playerStatus.js";

const BASE_MARKER_DESKTOP = {
    offset: 12,
    size: 12,
    labelOffset: 6,
    labelHeight: 14,
    labelFontSize: "12px",
};
const BASE_MARKER_SHORT_LANDSCAPE = {
    offset: 8,
    size: 10,
    labelOffset: 4,
    labelHeight: 11,
    labelFontSize: "9px",
};
const PLAYER_EVENT_MARKER_DESKTOP = {
    offset: 20,
    deniedOffset: 32,
    denySize: 14,
    deniedSize: 12,
    tagSize: 8,
    headToHeadSize: 12,
    hoverGrowth: 4,
};
const PLAYER_EVENT_MARKER_SHORT_LANDSCAPE = {
    offset: 14,
    deniedOffset: 24,
    denySize: 12,
    deniedSize: 10,
    tagSize: 7,
    headToHeadSize: 10,
    hoverGrowth: 3,
};
const PRIMARY_Y_AXIS_ID = "score-axis";
const SPLIT_WORM_AXIS_PREFIX = "split-worm-axis:";
const PLAYER_SELECTION_ANIMATION_MS = 180;
const PLAYER_EVENT_HALO_ANIMATION_MS = 90;
const PLAYER_EVENT_MARKER_ANIMATION_MS = 60;
let splitWormMediaQuery = null;
let comparisonDetailsToggleSetup = false;

function getWormSelectionAnimation() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? false
        : { duration: PLAYER_SELECTION_ANIMATION_MS };
}

function getWormSlideDistance() {
    const plotHeight = Number(state.chart?.plotHeight) || 300;
    return Math.min(72, Math.max(40, plotHeight * 0.16));
}

function getSeriesSvgElements(series) {
    const seen = new Set();
    return [series?.group, series?.markerGroup, series?.dataLabelsGroup]
        .filter((wrapper) => {
            const element = wrapper?.element;
            if (!element || seen.has(element)) return false;
            seen.add(element);
            return true;
        });
}

function animateWormSeriesExit(series, animation) {
    if (!series || !animation) return;
    getSeriesSvgElements(series).forEach((wrapper) => {
        const element = wrapper.element;
        const parent = element.parentNode;
        if (!parent) return;

        const exitLayer = document.createElementNS(element.namespaceURI, "g");
        const clone = element.cloneNode(true);
        exitLayer.classList.add("worm-series-exit-clone");
        exitLayer.setAttribute("data-series-id", String(series.options?.id || ""));
        exitLayer.setAttribute("aria-hidden", "true");
        exitLayer.style.pointerEvents = "none";
        exitLayer.appendChild(clone);
        parent.insertBefore(exitLayer, element.nextSibling);

        if (typeof exitLayer.animate !== "function") {
            exitLayer.remove();
            return;
        }
        const slide = exitLayer.animate(
            [
                { opacity: Number.parseFloat(getComputedStyle(element).opacity) || 1, transform: "translateY(0)" },
                { opacity: 0, transform: `translateY(-${getWormSlideDistance()}px)` },
            ],
            {
                duration: animation.duration,
                easing: "cubic-bezier(0.22, 1, 0.36, 1)",
                fill: "forwards",
            }
        );
        slide.finished.catch(() => {}).finally(() => exitLayer.remove());
    });
}

function animateWormSeriesEntrance(series, animation) {
    if (!series || !animation) return;
    getSeriesSvgElements(series).forEach((wrapper) => {
        Highcharts.stop(wrapper);
        const targetY = Number(wrapper.translateY) || 0;
        wrapper.attr({ opacity: 1, translateY: targetY - getWormSlideDistance() });
        wrapper.animate({ translateY: targetY }, animation);
    });
}

function retirePlayerStatusOverlay(group, labelGroup, clip, animation, currentPlayerIds) {
    const destroy = () => {
        if (group?.element) group.destroy();
        if (labelGroup?.element) labelGroup.destroy();
        if (clip?.element) clip.destroy();
    };
    if (!animation) {
        destroy();
        return;
    }

    // Large translucent status bands must never overlap their replacements:
    // compositing both layers briefly makes the entire timeline flash brighter.
    // Keep only the departing player's narrow edge strips and labels so those
    // can slide away while every retained/new bar moves at its normal opacity.
    group?.element?.querySelectorAll(".player-status-band")
        .forEach((band) => band.remove());
    group?.element?.querySelectorAll(".player-edge-strip")
        .forEach((strip) => {
            if (currentPlayerIds.has(strip.getAttribute("data-player-id"))) strip.remove();
        });
    labelGroup?.element?.querySelectorAll(".player-timeline-label")
        .forEach((label) => {
            if (currentPlayerIds.has(label.getAttribute("data-player-id"))) label.remove();
            else label.classList.add("player-timeline-label-exit");
        });

    const hasOutgoingElements = Boolean(
        group?.element?.childElementCount || labelGroup?.element?.childElementCount
    );
    if (!hasOutgoingElements) {
        destroy();
        return;
    }

    group?.addClass("player-status-exit");
    labelGroup?.addClass("player-status-exit");
    const exitY = -getWormSlideDistance();
    group?.animate({ opacity: 0, translateY: exitY }, animation);
    labelGroup?.animate({ opacity: 0, translateY: exitY }, animation);
    setTimeout(destroy, animation.duration + 30);
}

function containMarkerCenterY(anchorY, preferredOffset, extent, minBoundary, maxBoundary) {
    const edgePadding = 1;
    const minY = minBoundary + edgePadding + extent;
    const maxY = maxBoundary - edgePadding - extent;
    if (maxY < minY) return (minBoundary + maxBoundary) / 2;
    const preferredY = anchorY + preferredOffset;
    if (preferredY >= minY && preferredY <= maxY) return preferredY;

    const alternateY = anchorY - preferredOffset;
    if (alternateY >= minY && alternateY <= maxY) return alternateY;

    return Math.max(minY, Math.min(maxY, preferredY));
}

function getSplitWormControl() {
    return document.getElementById("splitWormControl");
}

function getSplitWormToggle() {
    return document.getElementById("splitWormToggle");
}

function getComparisonDetailsToggle() {
    return document.getElementById("comparisonDetailsToggle");
}

function isDesktopTimeline() {
    return window.matchMedia(DESKTOP_TIMELINE_QUERY).matches;
}

function updateSplitWormControl() {
    const control = getSplitWormControl();
    const toggle = getSplitWormToggle();
    const detailsToggle = getComparisonDetailsToggle();
    const controlsHidden = state.selectedPlayers.size < 1 || !isDesktopTimeline();
    if (control && toggle) {
        control.hidden = controlsHidden;
        toggle.checked = Boolean(state.splitWorm);
    }
    if (detailsToggle) {
        const detailsEnabled = Boolean(state.comparisonDetails);
        detailsToggle.hidden = controlsHidden;
        detailsToggle.setAttribute("aria-pressed", String(detailsEnabled));
        detailsToggle.setAttribute("aria-label", "Show all tagged events");
        detailsToggle.title = "Show all tagged events";
    }
}

function getSplitWormAxisId(playerId) {
    return `${SPLIT_WORM_AXIS_PREFIX}${playerId}`;
}

function isSplitWormActive() {
    return Boolean(
        state.splitWorm &&
        state.selectedPlayers.size >= 2 &&
        isDesktopTimeline()
    );
}

function setSeriesYAxis(series, yAxisId) {
    if (!series || series.yAxis?.options?.id === yAxisId) return;
    series.update({ yAxis: yAxisId }, false);
}

function setPlayerSeriesYAxis(playerId, yAxisId) {
    ["-player", "-tags", "-base-destroys"].forEach((suffix) => {
        setSeriesYAxis(state.chart?.get(`${playerId}${suffix}`), yAxisId);
    });
}

function getSplitWormAxisOptions(playerId, index, count) {
    const color = getPlayerHighlightColor(playerId);
    return {
        id: getSplitWormAxisId(playerId),
        top: `${index * 100 / count}%`,
        height: `${100 / count}%`,
        offset: 0,
        title: { text: null },
        gridLineWidth: 0,
        softMin: 0,
        minPadding: 0.15,
        startOnTick: false,
        tickPixelInterval: 35,
        labels: { style: { color } },
        plotLines: [{
            value: 0,
            color,
            width: 1,
            zIndex: 2,
            dashStyle: "Dash",
        }],
    };
}

function updateSplitWormAxes() {
    const chart = state.chart;
    if (!chart?.yAxis?.[0]) return false;

    const selectedPlayerIds = [...state.selectedPlayers];
    const splitActive = isSplitWormActive();
    const splitAxes = () => [...chart.yAxis].filter((axis) =>
        String(axis.options?.id || "").startsWith(SPLIT_WORM_AXIS_PREFIX)
    );

    if (!splitActive) {
        selectedPlayerIds.forEach((playerId) =>
            setPlayerSeriesYAxis(playerId, PRIMARY_Y_AXIS_ID)
        );
        splitAxes().forEach((axis) => axis.remove(false));
        chart.get(PRIMARY_Y_AXIS_ID)?.update({ visible: true }, false);
        return false;
    }

    const selectedAxisIds = new Set(selectedPlayerIds.map(getSplitWormAxisId));
    splitAxes()
        .filter((axis) => !selectedAxisIds.has(axis.options.id))
        .forEach((axis) => axis.remove(false));
    chart.get(PRIMARY_Y_AXIS_ID)?.update({ visible: false }, false);

    selectedPlayerIds.forEach((playerId, index) => {
        const options = getSplitWormAxisOptions(playerId, index, selectedPlayerIds.length);
        const axis = chart.get(options.id);
        if (axis) axis.update(options, false);
        else chart.addAxis(options, false, false);
    });
    selectedPlayerIds.forEach((playerId) =>
        setPlayerSeriesYAxis(playerId, getSplitWormAxisId(playerId))
    );
    return true;
}

export function setupSplitWormToggle() {
    const toggle = getSplitWormToggle();
    if (!toggle || splitWormMediaQuery) return;

    toggle.checked = Boolean(state.splitWorm);
    toggle.addEventListener("change", () => {
        state.splitWorm = toggle.checked;
        updatePlayerSeriesDisplay();
    });

    splitWormMediaQuery = window.matchMedia(DESKTOP_TIMELINE_QUERY);
    const handleLayoutChange = () => {
        updateSplitWormControl();
        if (state.chart) updatePlayerSeriesDisplay();
    };
    if (typeof splitWormMediaQuery.addEventListener === "function") {
        splitWormMediaQuery.addEventListener("change", handleLayoutChange);
    } else {
        splitWormMediaQuery.addListener(handleLayoutChange);
    }
    updateSplitWormControl();
}

export function setupComparisonDetailsToggle() {
    const toggle = getComparisonDetailsToggle();
    if (!toggle || comparisonDetailsToggleSetup) return;

    comparisonDetailsToggleSetup = true;
    toggle.addEventListener("click", () => {
        state.comparisonDetails = !state.comparisonDetails;
        updateSplitWormControl();
        updatePlayerSeriesDisplay();
    });
    updateSplitWormControl();
}

function registerStarMarker() {
    const symbols = globalThis.Highcharts?.SVGRenderer?.prototype?.symbols;
    if (!symbols || symbols.star) return;

    symbols.star = (x, y, width, height) => {
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        const outerRadius = Math.min(width, height) / 2;
        const innerRadius = outerRadius * 0.45;
        const path = [];

        for (let point = 0; point < 10; point++) {
            const radius = point % 2 === 0 ? outerRadius : innerRadius;
            const angle = -Math.PI / 2 + point * Math.PI / 5;
            path.push([
                point === 0 ? "M" : "L",
                centerX + Math.cos(angle) * radius,
                centerY + Math.sin(angle) * radius,
            ]);
        }
        path.push(["Z"]);
        return path;
    };
}

registerStarMarker();

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
    const selectionAnimation = chart.teamVisibilityInitialised
        ? getWormSelectionAnimation()
        : false;
    const enteringSeries = [];
    chart.teamVisibilityInitialised = true;
    gameData.teams.forEach((team) => {
        const live = chart.get(`${team.id}-live`);
        const ghost = chart.get(`${team.id}-ghost`);
        const hidden = selectedSet ? selectedSet.has(team.id) : false;
        const visible = showAll || !hidden;
        [live, ghost].forEach((series) => {
            if (!series || series.visible === visible) return;
            if (visible) enteringSeries.push(series);
            else animateWormSeriesExit(series, selectionAnimation);
            series.setVisible(visible, false);
        });
    });
    filterBaseDestroySeries(selectedSet);
    chart.redraw(selectionAnimation || undefined);
    enteringSeries.forEach((series) =>
        animateWormSeriesEntrance(series, selectionAnimation)
    );
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

function getPlayerMarkerColor(playerId, fallback = "") {
    const resolvedPlayerId = String(playerId ?? "");
    const player = state.gameData?.players?.[resolvedPlayerId];
    if (!player) return fallback;
    // Tag fills identify the other player's team; selecting that player must
    // not replace the team colour with their individual highlight colour.
    const team = state.gameData?.teams?.find(
        (item) => String(item.id) === String(player.team)
    );
    return team?.color || fallback;
}

export function updatePlayerSeriesDisplay(redraw = true) {
    updateSplitWormControl();
    if (!state.chart || !state.gameData || !state.gameData.players) return;
    const compactMarkers = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
    const selectedPlayerSignature = [...state.selectedPlayers].join("\u001f");
    const selectionChanged = state.chart.playerSelectionSignature !== selectedPlayerSignature;
    const selectionAnimation = selectionChanged ? getWormSelectionAnimation() : false;
    const enteringPlayerIds = new Set();
    state.chart.playerSelectionSignature = selectedPlayerSignature;

    // Remove deselected players before removing any split axes they used.
    Object.keys(state.playerTimelines).forEach((pid) => {
        if (!state.selectedPlayers.has(pid)) {
        const sid = pid + "-player";
        const s = state.chart.get(sid);
        if (s) {
            animateWormSeriesExit(s, selectionAnimation);
            s.remove(false, false);
        }
        const tagSeries = state.chart.get(pid + "-tags");
        if (tagSeries) {
            animateWormSeriesExit(tagSeries, selectionAnimation);
            tagSeries.remove(false, false);
        }
        const baseDestroySeries = state.chart.get(pid + "-base-destroys");
        if (baseDestroySeries) {
            animateWormSeriesExit(baseDestroySeries, selectionAnimation);
            baseDestroySeries.remove(false, false);
        }
        }
    });

    const splitActive = updateSplitWormAxes();

    // Add missing series for every selected pid.
    state.selectedPlayers.forEach((pid) => {
        if (!state.gameData.players[pid]) return;
        const sid = pid + "-player";
        const yAxis = splitActive ? getSplitWormAxisId(pid) : PRIMARY_Y_AXIS_ID;
        const playerSeries = state.chart.get(sid);
        const playerSeriesData = getVisiblePlayerTimeline(pid, state.currentTime);
        if (!playerSeries) {
        enteringPlayerIds.add(pid);
        state.chart.addSeries({
            id: sid,
            name: state.gameData.players[pid].name,
            data: playerSeriesData,
            color: getPlayerHighlightColor(pid),
            dashStyle: "ShortDot",
            marker: { enabled: false },
            yAxis,
            zIndex: 4,
        }, false);
        } else {
        playerSeries.setData(
            playerSeriesData,
            false,
            selectionAnimation
        );
        setSeriesYAxis(playerSeries, yAxis);
        }

        const tagSeriesId = pid + "-tags";
        const color = getPlayerHighlightColor(pid);
        const hideUnselectedIncomingTags =
            !state.comparisonDetails && state.selectedPlayers.size > 0;
        const tagPoints = (state.playerEvents?.[pid] || [])
            .filter((ev) => ["tag", "deny", "tagged", "denied"].includes(ev.type))
            .filter((ev) =>
                !hideUnselectedIncomingTags ||
                ev.type !== "tagged" ||
                state.selectedPlayers.has(String(ev.target))
            )
            .map((ev) => {
                const timeline = state.playerTimelines[pid] || [[0, 0]];
                const scorePoint = timeline[Math.min(Math.floor(ev.time), timeline.length - 1)];
                const player = state.gameData.players?.[pid];
                const target = state.gameData.players?.[ev.target];
                const isIncoming = ev.type === "tagged" || ev.type === "denied";
                const isDeny = ev.type === "deny" || ev.type === "denied";
                const deniedPlayer = ev.type === "deny" ? target : player;
                const denierPlayer = ev.type === "denied" ? target : player;
                const deniedTeam = state.gameData.teams?.find(
                    (item) => String(item.id) === String(deniedPlayer?.team)
                );
                const denierTeam = state.gameData.teams?.find(
                    (item) => String(item.id) === String(denierPlayer?.team)
                );
                // Deny records identify the two players but not the base. A
                // deny happens while the denying player defends their team base.
                const targetBase = isDeny
                    ? findBaseByTarget(
                        state.gameData.active_bases,
                        denierTeam?.id ?? denierPlayer?.team
                    )
                    : null;
                const targetBaseTeam = isDeny
                    ? state.gameData.teams?.find(
                        (item) => String(item.id) === String(targetBase?.team)
                    )
                    : null;
                const isSharedSelectedTag =
                    (ev.type === "tag" || ev.type === "tagged") &&
                    state.selectedPlayers.has(String(ev.target));
                let markerColor = getPlayerMarkerColor(ev.target, color);
                if (ev.type === "deny") {
                    markerColor = deniedTeam?.color || markerColor;
                } else if (ev.type === "denied") {
                    markerColor = targetBase?.color || targetBaseTeam?.color ||
                        denierTeam?.color || markerColor;
                }
                return {
                    x: ev.time,
                    y: scorePoint?.[1] || 0,
                    color: markerColor,
                    targetName: target?.name || ev.target || "Unknown player",
                    targetBaseName: isDeny
                        ? getBaseDisplayName(
                            targetBase,
                            targetBaseTeam,
                            denierTeam?.name || denierTeam?.id || "?"
                        )
                        : null,
                    eventType: ev.type,
                    playerBorderColor: color,
                    isSharedSelectedTag,
                    marker: (isDeny || isIncoming)
                        ? {
                            enabled: false,
                            states: { hover: { enabled: false } },
                        }
                        : {
                            fillColor: markerColor,
                            lineColor: color,
                            ...(isSharedSelectedTag ? {
                                radius: (compactMarkers
                                    ? PLAYER_EVENT_MARKER_SHORT_LANDSCAPE
                                    : PLAYER_EVENT_MARKER_DESKTOP).headToHeadSize / 2,
                                lineWidth: 2,
                                states: {
                                    hover: {
                                        enabled: true,
                                        radius: compactMarkers ? 7 : 8,
                                    },
                                },
                            } : {}),
                        },
                };
            });
        const tagSeries = state.chart.get(tagSeriesId);
        if (!tagSeries) {
        state.chart.addSeries({
            id: tagSeriesId,
            linkedTo: sid,
            type: "scatter",
            name: `${state.gameData.players[pid].name} tags`,
            data: tagPoints,
            color,
            yAxis,
            marker: {
                enabled: true,
                symbol: "circle",
                radius: compactMarkers ? 3.5 : 4,
                fillColor: color,
                lineColor: "#ffffff",
                lineWidth: 1,
                states: { hover: { enabled: true, radius: compactMarkers ? 5 : 6 } },
            },
            softThreshold: false,
            showInLegend: false,
            zIndex: 6,
        }, false);
        } else {
        tagSeries.setData(tagPoints, false, selectionAnimation);
        setSeriesYAxis(tagSeries, yAxis);
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
        const comparisonMarkerSize = (compactMarkers
            ? PLAYER_EVENT_MARKER_SHORT_LANDSCAPE
            : PLAYER_EVENT_MARKER_DESKTOP).headToHeadSize;
        if (baseDestroySeries) {
            baseDestroySeries.setData(baseDestroyPoints, false, selectionAnimation);
        } else {
            state.chart.addSeries({
                id: `${pid}-base-destroys`,
                type: "scatter",
                showInLegend: false,
                zIndex: 7,
                name: `${state.gameData.players[pid].name} base destroys`,
                yAxis,
                marker: {
                    enabled: true,
                    symbol: "diamond",
                    radius: comparisonMarkerSize / 2,
                    lineColor: "#ffffff",
                    lineWidth: 2,
                    states: { hover: { enabled: true, radius: comparisonMarkerSize / 2 + 2 } },
                },
                data: baseDestroyPoints,
            }, false);
        }
        setSeriesYAxis(baseDestroySeries || state.chart.get(`${pid}-base-destroys`), yAxis);
    });

    if (redraw) {
        state.chart.redraw(selectionAnimation || undefined);
        if (selectionAnimation) {
            enteringPlayerIds.forEach((pid) => {
                ["-player", "-tags", "-base-destroys"].forEach((suffix) =>
                    animateWormSeriesEntrance(state.chart.get(`${pid}${suffix}`), selectionAnimation)
                );
            });
        }
    }
    else updatePlayerStatusBands();
}

function updatePlayerStatusBands() {
    const chart = state.chart;
    if (!chart) return;
    const axis = chart.xAxis[0];
    if (!axis) return;
    const pids = Array.from(state.selectedPlayers || []);
    const previousPids = chart.customPlayerBandPlayerIds || [];
    const selectionChanged = pids.join("\u001f") !== previousPids.join("\u001f");
    const selectionAnimation = selectionChanged ? getWormSelectionAnimation() : false;
    chart.customPlayerBandPlayerIds = [...pids];

    const previousGroup = chart.customPlayerStatusGroup;
    const previousClip = chart.customPlayerStatusClip;
    const previousLabelGroup = chart.customPlayerLabelGroup;
    chart.customPlayerStatusGroup = null;
    chart.customPlayerStatusClip = null;
    chart.customPlayerLabelGroup = null;
    retirePlayerStatusOverlay(
        previousGroup,
        previousLabelGroup,
        previousClip,
        selectionAnimation,
        new Set(pids.map(String))
    );

    if (pids.length === 0) return;

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
    const bandHeight = plotHeight / pids.length;
    const stripWidth = 4;
    const labelGroup = chart.renderer.g("player-timeline-labels").attr({ zIndex: 8 }).add();
    labelGroup.clip(clip);
    const deadColor = "rgba(255, 80, 80, 0.18)";
    const aliveColor = "rgba(80, 255, 140, 0.08)";
    const reloadColor = "rgba(83, 216, 251, 0.22)";
    const zeroLivesColor = "rgba(255, 184, 77, 0.30)";

    pids.forEach((pid, idx) => {
        const y = plotTop + idx * bandHeight;
        const previousIndex = previousPids.indexOf(pid);
        const previousBandHeight = previousPids.length
            ? plotHeight / previousPids.length
            : bandHeight;
        const previousY = previousIndex >= 0
            ? plotTop + previousIndex * previousBandHeight
            : plotTop - bandHeight;
        const initialBandHeight = previousIndex >= 0 ? previousBandHeight : bandHeight;
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

        [plotLeft, plotLeft + plotWidth - stripWidth].forEach((x) => {
            const strip = chart.renderer
                .rect(
                    x,
                    selectionAnimation ? previousY : y,
                    stripWidth,
                    selectionAnimation ? initialBandHeight : bandHeight
                )
                .attr({
                    fill: playerColor,
                    opacity: 1,
                    zIndex: 2,
                })
                .addClass("player-edge-strip")
                .attr({ "data-player-id": String(pid) })
                .add(group);
            if (selectionAnimation) {
                strip.animate(
                    { y, height: bandHeight },
                    selectionAnimation
                );
            }
        });

        const playerName = state.gameData?.players?.[pid]?.name || pid;
        const fontSize = Math.max(8, Math.min(11, bandHeight * 0.22));
        const labelY = y + bandHeight / 2;
        const inset = stripWidth + 14;
        const maxLabelWidth = Math.max(18, bandHeight - 16);
        [
            { x: plotLeft + inset, rotation: -90 },
            { x: plotLeft + plotWidth - inset, rotation: 90 },
        ].forEach(({ x, rotation }) => {
            const label = chart.renderer
                .text(
                    playerName,
                    x,
                    selectionAnimation ? previousY + initialBandHeight / 2 : labelY
                )
                .addClass("player-timeline-label")
                .attr({
                    align: "center",
                    opacity: selectionAnimation && previousIndex < 0 ? 0 : 1,
                    rotation,
                    "aria-hidden": true,
                    "data-player-id": String(pid),
                })
                .css({
                    color: playerColor,
                    fontSize: `${fontSize}px`,
                    fontWeight: "700",
                    letterSpacing: "0.08em",
                    textOverflow: "ellipsis",
                    textOutline: "1px #1e1e1e",
                    whiteSpace: "nowrap",
                    width: `${maxLabelWidth}px`,
                })
                .add(labelGroup);
            if (selectionAnimation) {
                label.animate({ y: labelY, opacity: 1 }, selectionAnimation);
            }
        });

        const pushBand = (from, to, color) => {
            if (to <= from) return;
            const x1 = axis.toPixels(from, false);
            const x2 = axis.toPixels(to, false);
            if (!Number.isFinite(x1) || !Number.isFinite(x2)) return;
            const width = Math.max(0, x2 - x1);
            if (width <= 0) return;
            // Status shading is drawn once at its final geometry. Sliding two
            // translucent fills through each other compounds their alpha and
            // creates a distracting brightness flash; the opaque edge strips
            // carry the visible slide transition instead.
            chart.renderer
                .rect(
                    x1,
                    y,
                    width,
                    bandHeight
                )
                .attr({
                    fill: color,
                    opacity: 1,
                    zIndex: 1,
                })
                .addClass("player-status-band")
                .attr({ "data-player-id": String(pid) })
                .add(group);
        };

        const lifeTimeline = buildPlayerLifeTimeline(pid);
        const lifeChangeTimes = lifeTimeline?.slice(1).map((point) => point.time) || [];
        let lifePointIndex = 0;
        const pushStatusBand = (from, to, statusColor) => {
            if (!lifeTimeline) {
                pushBand(from, to, statusColor);
                return;
            }

            const boundaries = [
                from,
                ...lifeChangeTimes.filter((time) => time > from && time < to),
                to,
            ];
            boundaries.forEach((start, index) => {
                const end = boundaries[index + 1];
                if (end === undefined) return;
                while (
                    lifePointIndex + 1 < lifeTimeline.length &&
                    lifeTimeline[lifePointIndex + 1].time <= start
                ) {
                    lifePointIndex++;
                }
                pushBand(
                    start,
                    end,
                    lifeTimeline[lifePointIndex].lives === 0 ? zeroLivesColor : statusColor
                );
            });
        };

        const statusColors = {
            alive: aliveColor,
            dead: deadColor,
            reloading: reloadColor,
        };
        buildPlayerStatusPeriods(state.playerEvents?.[pid], gameEnd)
            .forEach(({ from, to, status }) =>
                pushStatusBand(from, to, statusColors[status])
            );
    });

    chart.customPlayerStatusGroup = group;
    chart.customPlayerStatusClip = clip;
    chart.customPlayerLabelGroup = labelGroup;
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
        backgroundColor: "transparent",
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
                chart.baseDestroyStemOverlayGroup?.destroy();
                chart.baseDestroyOverlayGroup?.destroy();
                const stemOverlay = chart.renderer.g().attr({ zIndex: 2 }).add();
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
                    const raisedEndY = y - marker.offset;
                    const renderBelow = raisedEndY - marker.labelOffset - marker.labelHeight < 1;
                    const endY = y + (renderBelow ? marker.offset : -marker.offset);
                    const stem = chart.renderer.path(["M", x, y, "L", x, endY]).attr({
                        stroke: color,
                        "stroke-width": 1,
                        "stroke-opacity": 0.6,
                    }).add(stemOverlay);
                    const triangle = chart.renderer.symbol(
                        "triangle",
                        x - marker.size / 2,
                        endY - marker.size / 2,
                        marker.size,
                        marker.size
                    ).attr({
                        fill: color,
                        stroke: "#111",
                        "stroke-width": 2,
                    }).add(overlay);
                    const label = chart.renderer.text(
                        targetBaseLabel,
                        x,
                        renderBelow
                            ? endY + marker.labelOffset + marker.labelHeight
                            : endY - marker.labelOffset
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
                chart.baseDestroyStemOverlayGroup = stemOverlay;
                chart.baseDestroyOverlayGroup = overlay;
            }

            const chart = this;
            const eventMarker = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches
                ? PLAYER_EVENT_MARKER_SHORT_LANDSCAPE
                : PLAYER_EVENT_MARKER_DESKTOP;
            chart.playerEventStemOverlayGroup?.destroy();
            chart.playerEventOverlayGroup?.destroy();
            const playerEventStemOverlay = chart.renderer.g().attr({ zIndex: 2 }).add();
            const playerEventOverlay = chart.renderer.g().attr({ zIndex: 7 }).add();
            playerEventOverlay.element.style.pointerEvents = "auto";

            chart.series
                .filter((tagSeries) => String(tagSeries.options.id || "").endsWith("-tags"))
                .forEach((tagSeries) => {
                    tagSeries.points
                        .filter((point) => ["deny", "tagged", "denied"].includes(point.eventType))
                        .forEach((point) => {
                            if (!Number.isFinite(point.plotX) || !Number.isFinite(point.plotY)) return;
                            const x = chart.plotLeft + point.plotX;
                            const axisTop = tagSeries.yAxis?.pos ?? chart.plotTop;
                            const axisBottom = axisTop + (tagSeries.yAxis?.len ?? chart.plotHeight);
                            const y = axisTop + point.plotY;
                            const isTagged = point.eventType === "tagged";
                            const isDenied = point.eventType === "denied";
                            const isDeny = point.eventType === "deny" || isDenied;
                            const isSharedSelectedTag =
                                isTagged && point.isSharedSelectedTag;
                            const preferredOffset = isDenied
                                ? eventMarker.deniedOffset
                                : (isTagged ? eventMarker.offset : -eventMarker.offset);
                            const baseMarkerSize = isDenied
                                ? eventMarker.deniedSize
                                : (isTagged ? eventMarker.tagSize : eventMarker.denySize);
                            const markerSize = isSharedSelectedTag
                                ? eventMarker.headToHeadSize
                                : baseMarkerSize;
                            const hoverSize = markerSize + eventMarker.hoverGrowth;
                            const hitSize = Math.max(hoverSize + 4, 14);
                            const markerExtent = Math.max(10, hoverSize / 2, hitSize / 2);
                            const markerY = containMarkerCenterY(
                                y,
                                preferredOffset,
                                markerExtent,
                                axisTop,
                                axisBottom
                            );
                            const markerPlotY = markerY - chart.plotTop;
                            const markerSymbol = isDenied
                                ? "triangle-down"
                                : (isTagged ? "circle" : "star");
                            const markerStrokeWidth = markerSymbol === "star"
                                ? 1
                                : (isDeny || isSharedSelectedTag ? 2 : 1);
                            const color = point.color || tagSeries.color || "#ffffff";
                            const borderColor =
                                point.playerBorderColor || tagSeries.color || "#ffffff";
                            // The marker can identify another player or team, but its
                            // stem always connects back to this highlighted player.
                            const stemColor = tagSeries.color || "#ffffff";
                            point.tooltipPos = [point.plotX, markerPlotY];
                            const stem = chart.renderer.path(["M", x, y, "L", x, markerY]).attr({
                                stroke: stemColor,
                                "stroke-width": 1,
                                "stroke-opacity": 0.65,
                                zIndex: 0,
                            }).add(playerEventStemOverlay);
                            const halo = chart.renderer.circle(x, markerY, 0).attr({
                                fill: color,
                                "fill-opacity": 0,
                                zIndex: 1,
                            }).add(playerEventOverlay);
                            const eventSymbol = chart.renderer.symbol(
                                markerSymbol,
                                x - markerSize / 2,
                                markerY - markerSize / 2,
                                markerSize,
                                markerSize
                            ).attr({
                                fill: color,
                                stroke: borderColor,
                                "stroke-width": markerStrokeWidth,
                                "data-base-name": point.targetBaseName || "",
                                "data-event-type": point.eventType,
                                "data-player-id": String(tagSeries.options.id || "")
                                    .replace(/-tags$/, ""),
                                zIndex: 2,
                            }).addClass("player-event-symbol").add(playerEventOverlay);
                            const hitTarget = chart.renderer.symbol(
                                "circle",
                                x - hitSize / 2,
                                markerY - hitSize / 2,
                                hitSize,
                                hitSize
                            ).attr({
                                fill: "rgba(0,0,0,0)",
                                stroke: "rgba(0,0,0,0)",
                                "stroke-width": 0,
                                zIndex: 3,
                            }).add(playerEventOverlay);
                            hitTarget.element.addEventListener("mouseenter", () => {
                                halo.animate({
                                    r: 10,
                                    "fill-opacity": 0.25,
                                }, { duration: PLAYER_EVENT_HALO_ANIMATION_MS });
                                eventSymbol.animate({
                                    x: x - hoverSize / 2,
                                    y: markerY - hoverSize / 2,
                                    width: hoverSize,
                                    height: hoverSize,
                                }, { duration: PLAYER_EVENT_MARKER_ANIMATION_MS });
                                chart.tooltip.refresh(point);
                            });
                            hitTarget.element.addEventListener("mouseleave", () => {
                                halo.animate({
                                    r: 0,
                                    "fill-opacity": 0,
                                }, { duration: PLAYER_EVENT_HALO_ANIMATION_MS });
                                eventSymbol.animate({
                                    x: x - markerSize / 2,
                                    y: markerY - markerSize / 2,
                                    width: markerSize,
                                    height: markerSize,
                                }, { duration: PLAYER_EVENT_MARKER_ANIMATION_MS });
                                chart.tooltip.hide();
                            });
                        });
                });
            chart.playerEventStemOverlayGroup = playerEventStemOverlay;
            chart.playerEventOverlayGroup = playerEventOverlay;

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
        id: PRIMARY_Y_AXIS_ID,
        title: { text: "Score", style: { color: "#ccc" } },
        gridLineWidth: 0,
        gridLineColor: "rgba(136, 136, 136, 0.3)",
        softMin: 0,
        minPadding: 0.15,
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
        hideDelay: 0,
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
            const playerName = this.series.name.replace(/ tags$/, "");
            if (this.point.eventType === "deny") {
                const base = this.point.targetBaseName
                    ? ` at ${this.point.targetBaseName} Base`
                    : "";
                return (
                    `<span style="color:${this.point.color}">\u2605</span> ` +
                    `${formatTime(this.x)} — <b>${playerName}</b> denied ` +
                    `<b>${this.point.targetName}</b>${base}`
                );
            }
            if (this.point.eventType === "denied") {
                const base = this.point.targetBaseName
                    ? ` at ${this.point.targetBaseName} Base`
                    : "";
                return (
                    `<span style="color:${this.point.color}">\u25BC</span> ` +
                    `${formatTime(this.x)} — <b>${playerName}</b> was denied by ` +
                    `<b>${this.point.targetName}</b>${base}`
                );
            }
            if (this.point.eventType === "tagged") {
                return (
                    `<span style="color:${this.point.color}">\u25CF</span> ` +
                    `${formatTime(this.x)} — <b>${playerName}</b> was tagged by ` +
                    `<b>${this.point.targetName}</b>`
                );
            }
            return (
                `<span style="color:${this.point.color}">\u25CF</span> ` +
                `${formatTime(this.x)} — <b>${playerName}</b> tagged ` +
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
    cursorGroup.element.style.pointerEvents = "none";

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
    hoverGroup.element.style.pointerEvents = "none";
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
    if (state.livePlaybackLocked) {
        state.selectedPlayers.forEach((playerId) => {
            state.chart.get(`${playerId}-player`)?.setData(
                getVisiblePlayerTimeline(playerId, inCurrentTime),
                false,
                false
            );
        });
    }
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

function getVisiblePlayerTimeline(playerId, currentTime) {
    const points = state.playerTimelines[playerId] || [[0, 0]];
    return state.livePlaybackLocked
        ? buildVisibleLivePoints(points, currentTime)
        : points;
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
        // Live snapshots can briefly contain a player before their team has
        // arrived (or retain an event for a team omitted by the summary).
        // There is no chart series for that team, so ignore the event until
        // the team metadata is present instead of aborting the whole render.
        if (!Object.hasOwn(timeline, teamId)) return;
        totals[teamId] += ev.delta ?? 0;
        timeline[teamId].push([ev.time, totals[teamId]]);
    });

    return timeline;
}
