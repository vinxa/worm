import { buildPlayerLifeTimeline, hexToRGBA, formatTime, getGameDuration, getLivePresentationTime, getPlayerHighlightColor, normaliseText } from "./utils.js";
import { jumpTo } from "./replayHandler.js";
import { state } from "./state.js";
import { COMPACT_LAYOUT_QUERY, DESKTOP_TIMELINE_QUERY, SHORT_LANDSCAPE_QUERY, TABLET_LAYOUT_QUERY } from "./config.js";
import { buildPlayerStatusPeriods } from "./playerStatus.js";
import { setShortcutTooltip } from "./shortcutTooltips.js";

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
const LEGACY_BASE_ATTEMPT_SECONDS = 5;
const INCOMING_DENIED_EVENT_TYPES = new Set(["denied", "team-denied"]);
let splitWormMediaQuery = null;
let mobileTimelineMediaQuery = null;
let tabletTimelineMediaQuery = null;
let comparisonDetailsToggleSetup = false;
let deniesToggleSetup = false;

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

function getSplitWormControls() {
    return [...document.querySelectorAll("[data-split-worm-control]")];
}

function getSplitWormToggles() {
    return [...document.querySelectorAll("[data-split-worm-toggle]")];
}

function getComparisonDetailsToggles() {
    return [...document.querySelectorAll("[data-comparison-details-toggle]")];
}

function getDeniesToggles() {
    return [...document.querySelectorAll("[data-denies-toggle]")];
}

function releasePointerFocus(event) {
    if (event.detail > 0 || event.pointerType) event.currentTarget.blur();
}

function isDesktopTimeline() {
    return window.matchMedia(DESKTOP_TIMELINE_QUERY).matches;
}

function isMobileTimeline() {
    return window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
}

function isTabletTimeline() {
    return window.matchMedia(TABLET_LAYOUT_QUERY).matches;
}

function comparisonDetailsEnabled() {
    return state.comparisonDetails && !isMobileTimeline();
}

function updateTimelineDisplayControls() {
    const noPlayersSelected = state.selectedPlayers.size < 1;
    const desktopTimeline = isDesktopTimeline();
    const mobileTimeline = isMobileTimeline();
    const tabletTimeline = isTabletTimeline();
    getSplitWormControls().forEach((control) => {
        const mobileControl = control.classList.contains("mobile-split-worm-control");
        const tabletControl = control.classList.contains("tablet-split-worm-control");
        const correctLayout = mobileControl
            ? mobileTimeline
            : tabletControl
                ? tabletTimeline
                : desktopTimeline && !tabletTimeline;
        control.hidden = noPlayersSelected || !correctLayout;
    });
    getSplitWormToggles().forEach((toggle) => {
        toggle.checked = Boolean(state.splitWorm);
    });
    getComparisonDetailsToggles().forEach((detailsToggle) => {
        const tabletControl = detailsToggle.classList.contains("tablet-comparison-details-toggle");
        const detailsEnabled = Boolean(state.comparisonDetails);
        detailsToggle.hidden = noPlayersSelected || (tabletControl
            ? !tabletTimeline
            : !desktopTimeline || tabletTimeline);
        detailsToggle.setAttribute("aria-pressed", String(detailsEnabled));
        detailsToggle.setAttribute("aria-label", "Show all tagged events");
        setShortcutTooltip(detailsToggle, "Show all tagged events");
    });
    getDeniesToggles().forEach((deniesToggle) => {
        const mobileControl = deniesToggle.classList.contains("mobile-denies-toggle");
        const tabletControl = deniesToggle.classList.contains("tablet-denies-toggle");
        const correctLayout = mobileControl
            ? mobileTimeline
            : tabletControl
                ? tabletTimeline
                : desktopTimeline && !tabletTimeline;
        deniesToggle.hidden = !correctLayout;
        deniesToggle.classList.toggle("denies-toggle--standalone", noPlayersSelected);
        deniesToggle.setAttribute("aria-pressed", String(Boolean(state.deniesVisible)));
        deniesToggle.setAttribute("aria-label", "Show denied events");
        setShortcutTooltip(deniesToggle, "Show denied events");
    });
}

function getSplitWormAxisId(playerId) {
    return `${SPLIT_WORM_AXIS_PREFIX}${playerId}`;
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

export function setupSplitWormToggle() {
    const toggles = getSplitWormToggles();
    if (!toggles.length || splitWormMediaQuery) return;

    toggles.forEach((toggle) => {
        toggle.checked = Boolean(state.splitWorm);
        toggle.addEventListener("click", releasePointerFocus);
        toggle.addEventListener("change", () => {
            state.splitWorm = toggle.checked;
            updateTimelineDisplayControls();
            updatePlayerSeriesDisplay();
        });
    });

    splitWormMediaQuery = window.matchMedia(DESKTOP_TIMELINE_QUERY);
    mobileTimelineMediaQuery = window.matchMedia(SHORT_LANDSCAPE_QUERY);
    tabletTimelineMediaQuery = window.matchMedia(TABLET_LAYOUT_QUERY);
    const handleLayoutChange = () => {
        updateTimelineDisplayControls();
        if (state.chart) updatePlayerSeriesDisplay();
    };
    [splitWormMediaQuery, mobileTimelineMediaQuery, tabletTimelineMediaQuery]
        .forEach((mediaQuery) => {
            if (typeof mediaQuery.addEventListener === "function") {
                mediaQuery.addEventListener("change", handleLayoutChange);
            } else {
                mediaQuery.addListener(handleLayoutChange);
            }
        });
    updateTimelineDisplayControls();
}

export function setupComparisonDetailsToggle() {
    const toggles = getComparisonDetailsToggles();
    if (!toggles.length || comparisonDetailsToggleSetup) return;

    comparisonDetailsToggleSetup = true;
    toggles.forEach((toggle) => {
        toggle.addEventListener("click", (event) => {
            state.comparisonDetails = !state.comparisonDetails;
            updateTimelineDisplayControls();
            updatePlayerSeriesDisplay();
            releasePointerFocus(event);
        });
    });
    updateTimelineDisplayControls();
}

export function setupDeniesToggle() {
    const toggles = getDeniesToggles();
    if (!toggles.length || deniesToggleSetup) return;

    deniesToggleSetup = true;
    toggles.forEach((toggle) => {
        toggle.addEventListener("click", (event) => {
            state.deniesVisible = !state.deniesVisible;
            updateTimelineDisplayControls();
            filterTeamDeniedSeries(state.hiddenTeams);
            updatePlayerSeriesDisplay();
            releasePointerFocus(event);
        });
    });
    updateTimelineDisplayControls();
}

{
    const symbols = globalThis.Highcharts?.SVGRenderer?.prototype?.symbols;
    if (symbols && !symbols.star) {
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
}

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

function findDeniedAtBase(data, event, denierTeamId, deniedPlayerId = event?.entity) {
    const explicitBase = findBaseByTarget(data.active_bases, event?.base);
    if (explicitBase) return explicitBase;

    // Older completed games do not carry the denial's base ID. Recover it
    // from the denied player's latest base hit when possible.
    const eventTime = Number(event?.time);
    const precedingHit = [...(data.events || [])]
        .filter((candidate) =>
            candidate?.type === "base hit" &&
            String(candidate.entity) === String(deniedPlayerId) &&
            Number(candidate.time) <= eventTime &&
            eventTime - Number(candidate.time) <= LEGACY_BASE_ATTEMPT_SECONDS
        )
        .sort((a, b) => Number(b.time) - Number(a.time))[0];
    const attemptedBase = findBaseByTarget(data.active_bases, precedingHit?.target);
    if (attemptedBase) return attemptedBase;

    return findBaseByTarget(data.active_bases, denierTeamId);
}

function isIncomingDeniedEvent(event) {
    return INCOMING_DENIED_EVENT_TYPES.has(event?.eventType ?? event?.type);
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

function buildTeamDeniedPoints(data) {
    const totals = {};
    const teamsById = {};

    data.teams.forEach((team) => {
        totals[team.id] = 0;
        teamsById[normaliseText(team.id)] = team;
    });

    const sortedEvents = [...data.events].sort((a, b) => a.time - b.time);

    return sortedEvents.reduce((points, event) => {
        const scoringPlayer = data.players[event.entity];
        if (!scoringPlayer) return points;

        const scoringTeamId = scoringPlayer.team;
        if (!(scoringTeamId in totals)) return points;
        totals[scoringTeamId] += event.delta ?? 0;
        if (!isIncomingDeniedEvent(event)) return points;

        const deniedPlayer = scoringPlayer;
        const deniedTeamId = scoringTeamId;
        const deniedTeam = teamsById[normaliseText(deniedTeamId)];
        const denier = data.players[event.target];
        const denierTeamId = denier?.team;
        const denierTeam = teamsById[normaliseText(denierTeamId)];
        const defendedBase = findDeniedAtBase(data, event, denierTeamId);
        const defendedBaseTeam = teamsById[normaliseText(defendedBase?.team)] || denierTeam;
        const defendedBaseName = getBaseDisplayName(
            defendedBase,
            defendedBaseTeam,
            denierTeam?.name || denierTeamId || "?"
        );

        points.push({
            x: event.time,
            y: totals[deniedTeamId],
            color: defendedBase?.color || defendedBaseTeam?.color || "#ffffff",
            stemColor: deniedTeam?.color || "#ffffff",
            deniedTeamId,
            deniedTeamName: deniedTeam?.name || deniedTeamId,
            denierTeamId,
            denierTeamName: denierTeam?.name || denierTeamId,
            denierName: denier?.name || denier?.id || event.target || "Unknown player",
            deniedName: deniedPlayer.name || deniedPlayer.id || event.entity,
            targetBaseName: defendedBaseName,
            eventType: event.type,
        });
        return points;
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
    const payload = filtered.map((pt) => ({ ...pt }));
    series.setData(payload, false, false);
}

function filterTeamDeniedSeries(selectedSet) {
    if (!state.chart) return;
    const series = state.chart.get("team-denied");
    if (!series) return;
    const allPoints = state.chart.teamDeniedAllPoints || [];
    const filtered = state.deniesVisible
        ? selectedSet && selectedSet.size
            ? allPoints.filter((point) => !selectedSet.has(point.deniedTeamId))
            : allPoints
        : [];
    series.setData(filtered.map((point) => ({ ...point })), false, false);
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
    filterTeamDeniedSeries(selectedSet);
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
        state.hiddenTeams = null;
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

    const buckets = {};
    const playerIds = Object.keys(data.players);
    playerIds.forEach((pid) => (buckets[pid] = {}));
    data.events.forEach((ev) => {
        const pid = ev.entity;
        if (!(pid in buckets)) return;
        const sec = Math.floor(ev.time);
        const d = ev.delta ?? 0;
        buckets[pid][sec] = (buckets[pid][sec] || 0) + d;
    });

    const timelines = {};
    const totals = {};
    playerIds.forEach((pid) => {
        totals[pid] = 0;
        timelines[pid] = [[0, 0]];
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

function updateSplitWormAxes(selectedPlayerIds) {
    const splitAxes = () => [...(state.chart.yAxis || [])].filter((axis) =>
        String(axis.options?.id || "").startsWith(SPLIT_WORM_AXIS_PREFIX)
    );
    const splitActive = Boolean(
        state.chart.yAxis?.[0] &&
        state.splitWorm &&
        selectedPlayerIds.length >= 2
    );

    if (!splitActive) {
        selectedPlayerIds.forEach((playerId) =>
            setPlayerSeriesYAxis(playerId, PRIMARY_Y_AXIS_ID)
        );
        splitAxes().forEach((axis) => axis.remove(false));
        state.chart.get(PRIMARY_Y_AXIS_ID)?.update({ visible: true }, false);
        return false;
    }

    const selectedAxisIds = new Set(selectedPlayerIds.map(getSplitWormAxisId));
    splitAxes()
        .filter((axis) => !selectedAxisIds.has(axis.options.id))
        .forEach((axis) => axis.remove(false));
    state.chart.get(PRIMARY_Y_AXIS_ID)?.update({ visible: false }, false);
    selectedPlayerIds.forEach((playerId, index) => {
        const color = getPlayerHighlightColor(playerId);
        const options = {
            id: getSplitWormAxisId(playerId),
            top: `${index * 100 / selectedPlayerIds.length}%`,
            height: `${100 / selectedPlayerIds.length}%`,
            offset: 0,
            title: { text: null },
            gridLineWidth: 0,
            ...getSplitWormScorePadding(playerId, selectedPlayerIds.length),
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
        const axis = state.chart.get(options.id);
        if (axis) axis.update(options, false);
        else state.chart.addAxis(options, false, false);
    });
    selectedPlayerIds.forEach((playerId) =>
        setPlayerSeriesYAxis(playerId, getSplitWormAxisId(playerId))
    );
    return true;
}

function getSplitWormScorePadding(playerId, selectedPlayerCount) {
    const hasTaggedEvent = (state.playerEvents?.[playerId] || [])
        .some((event) => event.type === "tagged");
    if (!hasTaggedEvent) return { softMin: 0, minPadding: 0.15 };

    const timeline = state.playerTimelines[playerId] || [[0, 0]];
    const scores = timeline
        .map((point) => Number(point?.[1]))
        .filter(Number.isFinite);
    const dataMin = scores.length ? Math.min(...scores) : 0;
    const dataMax = scores.length ? Math.max(...scores) : 0;
    const dataRange = Math.max(1, dataMax - dataMin);
    const marker = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches
        ? PLAYER_EVENT_MARKER_SHORT_LANDSCAPE
        : PLAYER_EVENT_MARKER_DESKTOP;
    const largestTaggedSize = isMobileTimeline()
        ? marker.tagSize
        : Math.max(marker.tagSize, marker.headToHeadSize);
    const taggedHoverSize = largestTaggedSize + marker.hoverGrowth;
    const taggedHitSize = Math.max(taggedHoverSize + 4, 14);
    const taggedExtent = Math.max(10, taggedHoverSize / 2, taggedHitSize / 2);
    const minimumTaggedSpace = largestTaggedSize / 2 + taggedExtent + 2;
    const preferredTaggedSpace = Math.max(marker.offset, taggedExtent + 1) +
        taggedExtent + 1;
    const axisHeight = Math.max(
        1,
        (Number(state.chart.plotHeight) || 1) / selectedPlayerCount
    );
    const taggedSpace = Math.min(
        preferredTaggedSpace,
        Math.max(minimumTaggedSpace, axisHeight * 0.24)
    );
    const lowerSpaceFraction = Math.min(0.8, taggedSpace / axisHeight);
    const maxPadding = 0.05;
    const lowerPadding = dataRange * lowerSpaceFraction *
        (1 + maxPadding) / (1 - lowerSpaceFraction);
    return {
        softMin: dataMin - lowerPadding,
        minPadding: 0,
        maxPadding,
    };
}

function getPlayerEventPointId(seriesKind, playerId, event, occurrences) {
    const identity = JSON.stringify([
        seriesKind,
        String(playerId),
        event?.seqNo ?? null,
        Number(event?.time) || 0,
        event?.type || "",
        event?.target ?? null,
        event?.base ?? null,
        event?.delta ?? null,
    ]);
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    return `${identity}:${occurrence}`;
}

function updateSelectedPlayerSeries(pid, {
    compactMarkers,
    splitActive,
    selectionAnimation,
    enteringPlayerIds,
}) {
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
        playerSeries.setData(playerSeriesData, false, selectionAnimation);
        setSeriesYAxis(playerSeries, yAxis);
    }

    const tagSeriesId = pid + "-tags";
    const color = getPlayerHighlightColor(pid);
    const hideUnselectedIncomingTags =
        !comparisonDetailsEnabled() && state.selectedPlayers.size > 0;
    const tagEventOccurrences = new Map();
    const tagPoints = (state.playerEvents?.[pid] || [])
        .filter((ev) => ["tag", "deny", "tagged"].includes(ev.type) || isIncomingDeniedEvent(ev))
        .filter((ev) => state.deniesVisible || (ev.type !== "deny" && !isIncomingDeniedEvent(ev)))
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
            const isDeny = ev.type === "deny";
            const isDenied = isIncomingDeniedEvent(ev);
            const isIncoming = ev.type === "tagged" || isDenied;
            const isDenyEvent = isDeny || isDenied;
            const deniedPlayer = isDeny ? target : player;
            const denierPlayer = isDenied ? target : null;
            const deniedTeam = state.gameData.teams?.find(
                (item) => String(item.id) === String(deniedPlayer?.team)
            );
            const denierTeam = state.gameData.teams?.find(
                (item) => String(item.id) === String((denierPlayer || player)?.team)
            );
            // Current denied records carry the attempted base. Older games
            // recover it from the denied player's preceding base hit.
            const targetBase = isDenyEvent
                ? findDeniedAtBase(
                    state.gameData,
                    ev,
                    denierTeam?.id ?? denierPlayer?.team,
                    isDeny ? ev.target : ev.entity
                )
                : null;
            const targetBaseTeam = isDenyEvent
                ? state.gameData.teams?.find(
                    (item) => String(item.id) === String(targetBase?.team)
                )
                : null;
            const isSharedSelectedTag =
                (ev.type === "tag" || ev.type === "tagged") &&
                state.selectedPlayers.has(String(ev.target));
            const sharedSelectedMarker = compactMarkers
                ? PLAYER_EVENT_MARKER_SHORT_LANDSCAPE
                : PLAYER_EVENT_MARKER_DESKTOP;
            const markerPlayer = state.gameData.players?.[String(ev.target ?? "")];
            const markerTeam = markerPlayer && state.gameData.teams?.find(
                (item) => String(item.id) === String(markerPlayer.team)
            );
            let markerColor = markerTeam?.color || color;
            if (isDeny) {
                markerColor = deniedTeam?.color || markerColor;
            } else if (isDenied) {
                markerColor = targetBase?.color || targetBaseTeam?.color ||
                    denierTeam?.color || markerColor;
            }
            return {
                id: getPlayerEventPointId("tag", pid, ev, tagEventOccurrences),
                x: ev.time,
                y: scorePoint?.[1] || 0,
                color: markerColor,
                targetName: target?.name || ev.target || "Unknown player",
                targetBaseName: isDenyEvent
                    ? getBaseDisplayName(
                        targetBase,
                        targetBaseTeam,
                        denierTeam?.name || denierTeam?.id || "?"
                    )
                    : null,
                eventType: ev.type,
                playerBorderColor: color,
                isSharedSelectedTag,
                marker: (isDenyEvent || isIncoming)
                    ? {
                        enabled: false,
                        states: { hover: { enabled: false } },
                    }
                    : {
                        fillColor: markerColor,
                        lineColor: color,
                        ...(isSharedSelectedTag ? {
                            radius: (compactMarkers
                                ? sharedSelectedMarker.tagSize
                                : sharedSelectedMarker.headToHeadSize) / 2,
                            lineWidth: compactMarkers ? 1 : 2,
                            states: {
                                hover: {
                                    enabled: true,
                                    radius: ((compactMarkers
                                        ? sharedSelectedMarker.tagSize
                                        : sharedSelectedMarker.headToHeadSize) +
                                        sharedSelectedMarker.hoverGrowth) / 2,
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
        tagSeries.setData(tagPoints, false, selectionAnimation, true);
        setSeriesYAxis(tagSeries, yAxis);
    }

    const playerTimeline = state.playerTimelines[pid] || [[0, 0]];
    const baseDestroyEventOccurrences = new Map();
    const baseDestroyPoints = (state.playerEvents?.[pid] || [])
        .filter((ev) => ev.type === "base destroy")
        .map((ev) => {
            const base = findBaseByTarget(state.gameData.active_bases, ev.target);
            const team = state.gameData.teams?.find(
                (item) => String(item.id) === String(base?.team)
            );
            return {
                id: getPlayerEventPointId(
                    "base-destroy",
                    pid,
                    ev,
                    baseDestroyEventOccurrences
                ),
                x: ev.time,
                y: playerTimeline[
                    Math.min(Math.floor(ev.time), playerTimeline.length - 1)
                ]?.[1] || 0,
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
}

export function updatePlayerSeriesDisplay(redraw = true) {
    updateTimelineDisplayControls();
    if (!state.chart || !state.gameData || !state.gameData.players) return;
    const compactMarkers = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
    const selectedPlayerSignature = [...state.selectedPlayers].join("\u001f");
    const selectionChanged = state.chart.playerSelectionSignature !== selectedPlayerSignature;
    const selectionAnimation = selectionChanged ? getWormSelectionAnimation() : false;
    const enteringPlayerIds = new Set();
    state.chart.playerSelectionSignature = selectedPlayerSignature;

    Object.keys(state.playerTimelines).forEach((pid) => {
        if (!state.selectedPlayers.has(pid)) {
            const sid = pid + "-player";
            const series = state.chart.get(sid);
            if (series) {
                animateWormSeriesExit(series, selectionAnimation);
                series.remove(false, false);
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

    const splitActive = updateSplitWormAxes([...state.selectedPlayers]);

    state.selectedPlayers.forEach((pid) => updateSelectedPlayerSeries(pid, {
        compactMarkers,
        splitActive,
        selectionAnimation,
        enteringPlayerIds,
    }));

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
}

function updatePlayerStatusBands() {
    const chart = state.chart;
    if (!chart) return;
    const axis = chart.xAxis[0];
    if (!axis) return;
    const pids = [...state.selectedPlayers];
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
    const destroyPreviousOverlay = () => {
        if (previousGroup?.element) previousGroup.destroy();
        if (previousLabelGroup?.element) previousLabelGroup.destroy();
        if (previousClip?.element) previousClip.destroy();
    };
    if (!selectionAnimation) {
        destroyPreviousOverlay();
    } else {
        const currentPlayerIds = new Set(pids.map(String));
        // Only opaque strips and labels animate out; overlapping translucent
        // status bands would briefly compound their brightness.
        previousGroup?.element?.querySelectorAll(".player-status-band")
            .forEach((band) => band.remove());
        previousGroup?.element?.querySelectorAll(".player-edge-strip")
            .forEach((strip) => {
                if (currentPlayerIds.has(strip.getAttribute("data-player-id"))) strip.remove();
            });
        previousLabelGroup?.element?.querySelectorAll(".player-timeline-label")
            .forEach((label) => {
                if (currentPlayerIds.has(label.getAttribute("data-player-id"))) label.remove();
                else label.classList.add("player-timeline-label-exit");
            });

        if (previousGroup?.element?.childElementCount ||
            previousLabelGroup?.element?.childElementCount) {
            previousGroup?.addClass("player-status-exit");
            previousLabelGroup?.addClass("player-status-exit");
            const exitY = -getWormSlideDistance();
            previousGroup?.animate({ opacity: 0, translateY: exitY }, selectionAnimation);
            previousLabelGroup?.animate({ opacity: 0, translateY: exitY }, selectionAnimation);
            setTimeout(destroyPreviousOverlay, selectionAnimation.duration + 30);
        } else {
            destroyPreviousOverlay();
        }
    }

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
        const statusColors = {
            alive: aliveColor,
            dead: deadColor,
            reloading: reloadColor,
        };
        buildPlayerStatusPeriods(state.playerEvents?.[pid], gameEnd)
            .forEach(({ from, to, status }) => {
                if (!lifeTimeline) {
                    pushBand(from, to, statusColors[status]);
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
                        lifeTimeline[lifePointIndex].lives === 0
                            ? zeroLivesColor
                            : statusColors[status]
                    );
                });
            });
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
        const isTabletLayout = window.matchMedia(TABLET_LAYOUT_QUERY).matches;
        const labelY = isShortLandscape || isTabletLayout
            ? chart.plotTop + 10
            : chart.plotTop - 2;
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

function getPlayerEventOverlayState(chart) {
    const existing = chart.playerEventOverlayState;
    if (existing?.stemGroup?.element && existing?.markerGroup?.element) return existing;

    const stemGroup = chart.renderer.g().attr({ zIndex: 2 }).add();
    const markerGroup = chart.renderer.g().attr({ zIndex: 7 }).add();
    markerGroup.element.style.pointerEvents = "auto";
    const overlayState = {
        stemGroup,
        markerGroup,
        items: new Map(),
    };
    chart.playerEventOverlayState = overlayState;
    chart.playerEventStemOverlayGroup = stemGroup;
    chart.playerEventOverlayGroup = markerGroup;
    return overlayState;
}

function getPlayerEventOverlayKey(tagSeries, point, occurrence) {
    return JSON.stringify([
        tagSeries.options.id || "",
        point.x,
        point.eventType || "",
        point.targetName || "",
        point.targetBaseName || "",
        occurrence,
    ]);
}

function createPlayerEventOverlayItem(chart, overlayState, markerSymbol) {
    const item = {
        point: null,
        markerSize: 0,
        hoverSize: 0,
        x: 0,
        y: 0,
        stem: chart.renderer.path().add(overlayState.stemGroup),
        halo: chart.renderer.circle(0, 0, 0).add(overlayState.markerGroup),
        eventSymbol: chart.renderer.symbol(markerSymbol, 0, 0, 0, 0)
            .addClass("player-event-symbol")
            .add(overlayState.markerGroup),
        hitTarget: chart.renderer.symbol("circle", 0, 0, 0, 0)
            .add(overlayState.markerGroup),
    };

    item.hitTarget.element.addEventListener("mouseenter", () => {
        item.halo.animate({
            r: 10,
            "fill-opacity": 0.25,
        }, { duration: PLAYER_EVENT_HALO_ANIMATION_MS });
        item.eventSymbol.animate({
            x: item.x - item.hoverSize / 2,
            y: item.y - item.hoverSize / 2,
            width: item.hoverSize,
            height: item.hoverSize,
        }, { duration: PLAYER_EVENT_MARKER_ANIMATION_MS });
        if (item.point) chart.tooltip.refresh(item.point);
    });
    item.hitTarget.element.addEventListener("mouseleave", () => {
        item.halo.animate({
            r: 0,
            "fill-opacity": 0,
        }, { duration: PLAYER_EVENT_HALO_ANIMATION_MS });
        item.eventSymbol.animate({
            x: item.x - item.markerSize / 2,
            y: item.y - item.markerSize / 2,
            width: item.markerSize,
            height: item.markerSize,
        }, { duration: PLAYER_EVENT_MARKER_ANIMATION_MS });
        chart.tooltip.hide();
    });
    return item;
}

function destroyPlayerEventOverlayItem(item) {
    [item.stem, item.halo, item.eventSymbol, item.hitTarget]
        .forEach((element) => element?.destroy());
}

function renderLiveChartOverlays(chart) {
    const baseDestroySeries = chart.get("base-destroys");
    if (baseDestroySeries) {
        const marker = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches
            ? BASE_MARKER_SHORT_LANDSCAPE
            : BASE_MARKER_DESKTOP;
        chart.baseDestroyStemOverlayGroup?.destroy();
        chart.baseDestroyOverlayGroup?.destroy();
        const stemOverlay = chart.renderer.g().attr({ zIndex: 2 }).add();
        const overlay = chart.renderer.g().attr({ zIndex: 7 }).add();
        overlay.element.style.pointerEvents = "auto";

        baseDestroySeries.points.forEach((point) => {
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

    const teamDeniedSeries = chart.get("team-denied");
    if (teamDeniedSeries) {
        const marker = window.matchMedia(SHORT_LANDSCAPE_QUERY).matches
            ? BASE_MARKER_SHORT_LANDSCAPE
            : BASE_MARKER_DESKTOP;
        chart.teamDeniedStemOverlayGroup?.destroy();
        chart.teamDeniedOverlayGroup?.destroy();
        const stemOverlay = chart.renderer.g().attr({ zIndex: 2 }).add();
        const overlay = chart.renderer.g().attr({ zIndex: 7 }).add();
        overlay.element.style.pointerEvents = "auto";

        teamDeniedSeries.points.forEach((point) => {
            const {
                plotX,
                plotY,
                color = "#ffffff",
                stemColor = "#ffffff",
            } = point;
            if (!Number.isFinite(plotX) || !Number.isFinite(plotY)) return;
            const x = chart.plotLeft + plotX;
            const y = chart.plotTop + plotY;
            const raisedEndY = y - marker.offset;
            const renderBelow = raisedEndY - marker.size / 2 < chart.plotTop;
            const endY = y + (renderBelow ? marker.offset : -marker.offset);
            point.tooltipPos = [point.plotX, endY - chart.plotTop];
            const stem = chart.renderer.path(["M", x, y, "L", x, endY]).attr({
                stroke: stemColor,
                "stroke-width": 1,
                "stroke-opacity": 0.6,
            }).add(stemOverlay);
            const triangle = chart.renderer.symbol(
                "triangle-down",
                x - marker.size / 2,
                endY - marker.size / 2,
                marker.size,
                marker.size
            ).addClass("team-denied-symbol").attr({
                fill: color,
                stroke: "#111",
                "stroke-width": 2,
                "data-team-id": String(point.deniedTeamId || ""),
                "data-event-type": point.eventType,
            }).add(overlay);
            [stem, triangle].forEach((element) => {
                element.element.addEventListener("mouseenter", () => chart.tooltip.refresh(point));
                element.element.addEventListener("mouseleave", () => chart.tooltip.hide());
            });
        });
        chart.teamDeniedStemOverlayGroup = stemOverlay;
        chart.teamDeniedOverlayGroup = overlay;
    }

    const mobileTimeline = isMobileTimeline();
    const eventMarker = mobileTimeline
        ? PLAYER_EVENT_MARKER_SHORT_LANDSCAPE
        : PLAYER_EVENT_MARKER_DESKTOP;
    const overlayState = getPlayerEventOverlayState(chart);
    const renderedKeys = new Set();
    const occurrenceCounts = new Map();

    chart.series
        .filter((tagSeries) => String(tagSeries.options.id || "").endsWith("-tags"))
        .forEach((tagSeries) => {
            // Incoming/custom events are rendered by the stable overlay below.
            // Highcharts can retain a native scatter graphic while reconciling
            // point IDs, so remove it explicitly to guarantee that an incoming
            // tagged dot never appears directly on the player worm.
            tagSeries.points.forEach((point) => {
                if (point.eventType !== "deny" && point.eventType !== "tagged" &&
                    !isIncomingDeniedEvent(point)) return;
                if (point.graphic) point.graphic = point.graphic.destroy();
            });
            tagSeries.points
                .filter((point) => point.eventType === "deny" ||
                    point.eventType === "tagged" || isIncomingDeniedEvent(point))
                .forEach((point) => {
                    if (!Number.isFinite(point.plotX) || !Number.isFinite(point.plotY)) return;
                    const x = chart.plotLeft + point.plotX;
                    const axisTop = tagSeries.yAxis?.pos ?? chart.plotTop;
                    const axisBottom = axisTop + (tagSeries.yAxis?.len ?? chart.plotHeight);
                    const y = axisTop + point.plotY;
                    const isTagged = point.eventType === "tagged";
                    const isDenied = isIncomingDeniedEvent(point);
                    const isDeny = point.eventType === "deny" || isDenied;
                    const isSharedSelectedTag = isTagged && point.isSharedSelectedTag;
                    const preferredOffset = isDenied
                        ? eventMarker.deniedOffset
                        : (isTagged ? eventMarker.offset : -eventMarker.offset);
                    const baseMarkerSize = isDenied
                        ? eventMarker.deniedSize
                        : (isTagged ? eventMarker.tagSize : eventMarker.denySize);
                    const markerSize = isSharedSelectedTag && !mobileTimeline
                        ? eventMarker.headToHeadSize
                        : baseMarkerSize;
                    const hoverSize = markerSize + eventMarker.hoverGrowth;
                    const hitSize = Math.max(hoverSize + 4, 14);
                    const markerExtent = Math.max(10, hoverSize / 2, hitSize / 2);
                    const minMarkerY = axisTop + markerExtent + 1;
                    const maxMarkerY = axisBottom - markerExtent - 1;
                    const preferredMarkerY = y + preferredOffset;
                    const alternateMarkerY = y - preferredOffset;
                    const minimumTaggedY = y + markerSize / 2 + 1;
                    const markerY = isTagged
                        ? Math.max(
                            minimumTaggedY,
                            Math.min(maxMarkerY, preferredMarkerY)
                        )
                        : maxMarkerY < minMarkerY
                            ? (axisTop + axisBottom) / 2
                            : preferredMarkerY >= minMarkerY && preferredMarkerY <= maxMarkerY
                                ? preferredMarkerY
                                : alternateMarkerY >= minMarkerY && alternateMarkerY <= maxMarkerY
                                    ? alternateMarkerY
                                    : Math.max(minMarkerY, Math.min(maxMarkerY, preferredMarkerY));
                    const markerPlotY = markerY - chart.plotTop;
                    const markerSymbol = isDenied
                        ? "triangle-down"
                        : (isTagged ? "circle" : "star");
                    const markerStrokeWidth = markerSymbol === "star"
                        ? 1
                        : (isDeny || (isSharedSelectedTag && !mobileTimeline) ? 2 : 1);
                    const color = point.color || tagSeries.color || "#ffffff";
                    const borderColor = point.playerBorderColor || tagSeries.color || "#ffffff";
                    const stemColor = tagSeries.color || "#ffffff";
                    point.tooltipPos = [point.plotX, markerPlotY];
                    const keyBase = getPlayerEventOverlayKey(tagSeries, point, 0);
                    const occurrence = occurrenceCounts.get(keyBase) || 0;
                    occurrenceCounts.set(keyBase, occurrence + 1);
                    const key = getPlayerEventOverlayKey(tagSeries, point, occurrence);
                    renderedKeys.add(key);
                    let item = overlayState.items.get(key);
                    if (!item) {
                        item = createPlayerEventOverlayItem(chart, overlayState, markerSymbol);
                        overlayState.items.set(key, item);
                    }

                    item.point = point;
                    item.markerSize = markerSize;
                    item.hoverSize = hoverSize;
                    item.x = x;
                    item.y = markerY;
                    Highcharts.stop(item.halo);
                    Highcharts.stop(item.eventSymbol);
                    item.stem.attr({
                        d: ["M", x, y, "L", x, markerY],
                        stroke: stemColor,
                        "stroke-width": 1,
                        "stroke-opacity": 0.65,
                        zIndex: 0,
                    });
                    item.halo.attr({
                        cx: x,
                        cy: markerY,
                        r: 0,
                        fill: color,
                        "fill-opacity": 0,
                        zIndex: 1,
                    });
                    item.eventSymbol.attr({
                        x: x - markerSize / 2,
                        y: markerY - markerSize / 2,
                        width: markerSize,
                        height: markerSize,
                        fill: color,
                        stroke: borderColor,
                        "stroke-width": markerStrokeWidth,
                        "data-base-name": point.targetBaseName || "",
                        "data-event-type": point.eventType,
                        "data-player-id": String(tagSeries.options.id || "").replace(/-tags$/, ""),
                        zIndex: 2,
                    });
                    item.hitTarget.attr({
                        x: x - hitSize / 2,
                        y: markerY - hitSize / 2,
                        width: hitSize,
                        height: hitSize,
                        fill: "rgba(0,0,0,0)",
                        stroke: "rgba(0,0,0,0)",
                        "stroke-width": 0,
                        zIndex: 3,
                    });
                });
        });
    overlayState.items.forEach((item, key) => {
        if (renderedKeys.has(key)) return;
        destroyPlayerEventOverlayItem(item);
        overlayState.items.delete(key);
    });

    updatePlayerStatusBands();
    if (chart.customCursorGroup) updateCursorPosition(state.currentTime);
}

function createLiveScoreChart(data) {
    const fullTimeline = buildTeamTimeline(data);
    const baseDestroyPoints = buildBaseDestroyPoints(data);
    const teamDeniedPoints = buildTeamDeniedPoints(data);
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
    const teamDeniedSeries = {
        id: "team-denied",
        type: "scatter",
        name: "Denied",
        data: state.deniesVisible ? teamDeniedPoints : [],
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
                click(e) {
                    const time = e.xAxis?.[0]?.value;
                    if (Number.isFinite(time)) jumpTo(time);
                },
                render() {
                    renderLiveChartOverlays(this);
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
                formatter() {
                    const minutes = Math.floor(this.value / 60);
                    const seconds = this.value % 60;
                    return `${minutes}:${seconds < 10 ? "0" + seconds : seconds}`;
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
            plotLines: [{
                value: 0,
                color: "#888",
                width: 1,
                zIndex: 2,
                dashStyle: "Dash",
            }],
        },
        series: [...ghostSeries, ...liveSeries, baseDestroySeries, teamDeniedSeries],
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
            formatter() {
                const id = this.series.options.id || "";
                if (id === "base-destroys") {
                    const target = this.point.targetBaseName
                        ? ` on ${this.point.targetBaseName} base`
                        : "";
                    return (
                        `<span style="color:${this.point.color}">\u25B2</span> ` +
                        `${formatTime(this.x)} — ` +
                        `<b>${this.point.playerName}</b> ` +
                        `(${this.point.attackerTeamName})${target}`
                    );
                }

                if (id === "team-denied") {
                    const base = this.point.targetBaseName
                        ? ` at ${this.point.targetBaseName} Base`
                        : "";
                    const deniedVerb = this.point.eventType === "team-denied"
                        ? "was team denied by"
                        : "was denied by";
                    return (
                        `<span style="color:${this.point.color}">▼</span> ` +
                        `${formatTime(this.x)} — <b>${this.point.deniedName}</b> ${deniedVerb} ` +
                        `<b>${this.point.denierName}</b>${base}`
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
                    if (isIncomingDeniedEvent(this.point)) {
                        const base = this.point.targetBaseName
                            ? ` at ${this.point.targetBaseName} Base`
                            : "";
                        const deniedVerb = this.point.eventType === "team-denied"
                            ? "was team denied by"
                            : "was denied by";
                        return (
                            `<span style="color:${this.point.color}">\u25BC</span> ` +
                            `${formatTime(this.x)} — <b>${playerName}</b> ${deniedVerb} ` +
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
                    const target = this.point.targetBaseName
                        ? ` destroyed ${this.point.targetBaseName} base`
                        : " destroyed a base";
                    return `${formatTime(this.x)} — ` +
                        `<b>${this.series.name.replace(/ base destroys$/, "")}</b>${target}`;
                }

                const sec = this.x;
                const isLive = id.endsWith("-live");
                const isGhost = id.endsWith("-ghost");
                if (sec <= state.currentTime && !isLive) return false;
                if (sec > state.currentTime && !isGhost) return false;
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
    return { chart, baseDestroyPoints, teamDeniedPoints };
}

function setupLiveChartInteractions(chart, baseDestroyPoints, teamDeniedPoints) {
    chart.baseDestroyAllPoints = baseDestroyPoints.map((pt) => ({ ...pt }));
    chart.teamDeniedAllPoints = teamDeniedPoints.map((point) => ({ ...point }));
    const left = chart.plotLeft;
    const top = chart.plotTop;
    const height = chart.plotHeight;

    const cursorGroup = chart.renderer.g().attr({ zIndex: 5 }).add();
    cursorGroup.element.style.pointerEvents = "none";

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
        .css({
            color: "#ddddddff",
            fontWeight: "bold",
            fontSize: "10px",
            textOutline: "1px #2A2A2A",
        })
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

}

export function initLiveChart(data) {
    if (state.chart) {
        state.chart.layoutResizeObserver?.disconnect();
        if (state.chart.layoutResizeFrame) {
            cancelAnimationFrame(state.chart.layoutResizeFrame);
        }
        state.chart.destroy();
        state.chart = null;
    }

    const { chart, baseDestroyPoints, teamDeniedPoints } = createLiveScoreChart(data);
    setupLiveChartInteractions(chart, baseDestroyPoints, teamDeniedPoints);
    applyTeamSeriesVisibility(state.hiddenTeams);
    updatePlayerStatusBands();
    return chart;
}

export function updateLiveSeries(inCurrentTime) {
    const chart = state.chart;
    if (!chart || !state.gameData?.teams) return;
    state.gameData.teams.forEach((team) => {
        const pts = buildVisibleLivePoints(state.teamFullTimeline[team.id] || [], inCurrentTime);
        chart.get(`${team.id}-live`)?.setData(pts, false, false);
    });
    if (state.livePlaybackLocked) {
        state.selectedPlayers.forEach((playerId) => {
            chart.get(`${playerId}-player`)?.setData(
                getVisiblePlayerTimeline(playerId, inCurrentTime),
                false,
                false
            );
        });
    }
    chart.redraw();
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
    if (!state.livePlaybackLocked) return points;

    // A detached playhead controls scores and playback, but it must not hide
    // player data that has continued to arrive from the live game. Cap the
    // worm at the delayed live edge (or the playhead when it is farther on),
    // never at an earlier rewound position.
    const liveEdge = getLivePresentationTime(state.gameData, state.selectedGame);
    return buildVisibleLivePoints(points, Math.max(Number(currentTime) || 0, liveEdge));
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
    const teamDeniedPoints = buildTeamDeniedPoints(data);
    chart.teamDeniedAllPoints = teamDeniedPoints.map((point) => ({ ...point }));
    filterBaseDestroySeries(state.hiddenTeams);
    filterTeamDeniedSeries(state.hiddenTeams);
    updatePlayerSeriesDisplay(false);
    return true;
}

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
