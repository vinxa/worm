import { buildPlayerLifeTimeline, computePlayerStats, computeBaseStats, computeTeamTotal, computeHeadToHeadTags, computeKillStreak, computePlayerUptime, computePlayerLives, getGameDuration, getPlayerHighlightColor, KILL_STREAK_THRESHOLD, normaliseText } from "./utils.js";
import { baseMatchesTargetKey, getBaseRunLayoutPlan, shouldUseCompactTeamTiles, shouldUseTeamColumns } from "./baseRun.js";
import { getClash3BaseRunPolicy } from "./events/clash3BaseRun.js";
import { isLiveGameSelected } from "./live.js";
import { state } from "./state.js";
import { updatePlayerSeriesDisplay, toggleTeamVisibility, setHiddenTeams } from "./timeline.js";
import { SHORT_LANDSCAPE_QUERY } from "./config.js";
import { fitBaseHitCounts, fitPlayerTagBreakdowns, fitTileContents, observeTileSizes, stopObservingTileSizes } from "./tileSizing.js";

const TILE_ORDER_CHECK_INTERVAL_MS = 300;
const TILE_REORDER_TRANSITION_MS = 240;
// The team-column variant uses the compact one-line detail row below.
const STANDARD_MINIMUM_TILE_WIDTH = 150;
const STANDARD_MINIMUM_TILE_HEIGHT = 25;
const STANDARD_FULL_TILE_HEIGHT = 110;
const BASE_RUN_FULL_TILE_HEIGHT = 112;
const BASE_HIT_FLASH_MS = 500;
const BASE_DESTROY_FLASH_MS = BASE_HIT_FLASH_MS * 2;
const DENY_LABEL_MS = 750;
const PENALTY_LABEL_MS = 2200;
const SHOT_ANIMATION_MS = 260;
const LIFE_STATE_ANIMATION_MS = 900;
const LIVE_KILL_STREAK_GLOW_THRESHOLD = 5;
const SHOT_EVENT_TYPES = new Set([
    "miss",
    "miss-base",
    "stun",
    "tag",
    "team-kill",
    "team-deny",
    "deny",
    "team-stun",
    "base hit",
    "base destroy",
]);
const baseHitFlashTimeouts = new Map();
const denyLabelTimeouts = new Map();
const penaltyLabelTimeouts = new Map();
const shotAnimationTimeouts = new Map();
const lifeStateAnimationTimeouts = new Map();
let lastTileUpdateTime = -Infinity;
let tileOrderCheckIntervalId = null;
let lastPlayerTileOrderSignature = "";
let lastPlayerLayoutSignature = "";
let lastTeamTileOrderSignature = "";

function animateTileEffect(pid, tile, {
    className,
    durationMs,
    durationProperty,
    timeoutMap,
    color = "",
    colorProperty = "--flash-color",
    restart = false,
}) {
    const duration = Math.max(90, durationMs / state.playbackRate);
    tile.style.setProperty(durationProperty, `${duration}ms`);
    if (color) tile.style.setProperty(colorProperty, color);
    if (restart) {
        tile.classList.remove(className);
        void tile.offsetWidth;
    }
    tile.classList.add(className);
    const existing = timeoutMap.get(pid);
    if (existing) clearTimeout(existing);
    const timeoutId = setTimeout(() => {
        tile.classList.remove(className);
        tile.style.removeProperty(durationProperty);
        if (color) tile.style.removeProperty(colorProperty);
        timeoutMap.delete(pid);
    }, duration);
    timeoutMap.set(pid, timeoutId);
}

function getPlayerTile(pid) {
    return Array.from(document.querySelectorAll(".player-summary"))
        .find((candidate) => candidate.dataset.playerId === String(pid));
}

function getBaseEventColor(event) {
    const targetId = normaliseText(event?.target);
    const targetBase = (state.gameData?.active_bases || []).find(
        (base) => normaliseText(base?.entityId) === targetId
    );
    const targetTeam = (state.gameData?.teams || []).find(
        (team) => normaliseText(team?.id) === normaliseText(targetBase?.team)
    );
    return targetTeam?.color || targetBase?.color || "#e2b12a";
}

function getPlayerColor(pid) {
    const player = state.gameData?.players?.[String(pid)];
    const team = (state.gameData?.teams || []).find(
        (candidate) => normaliseText(candidate?.id) === normaliseText(player?.team)
    );
    return team?.color || "";
}

function getDenyEventPresentation(event) {
    if (event?.type === "deny") return { incoming: false, label: "DENY" };
    if (event?.type === "denied") return { incoming: true, label: "DENIED" };
    if (event?.type === "time-denied") {
        return { incoming: true, label: "TIME DENIED" };
    }
    if (event?.type === "team-denied") {
        return { incoming: true, label: "TEAM DENIED" };
    }
    // The parser preserves the outgoing event as a team kill and marks both
    // halves with the attempted base when that team kill is also a deny.
    if (event?.type === "team-deny" || (event?.type === "team-kill" && event?.base)) {
        return { incoming: false, label: "TEAM DENY" };
    }
    return null;
}

function animateDenyEvent(event, tile = getPlayerTile(event?.entity)) {
    const presentation = getDenyEventPresentation(event);
    if (!event?.entity || !tile || !presentation) return;
    const pid = String(event.entity);
    const isDenied = presentation.incoming;
    const label = tile.querySelector(isDenied ? ".denied-label" : ".denies-label");
    if (label) label.textContent = presentation.label;
    tile.classList.remove("flash-denies", "flash-denied");
    void tile.offsetWidth;
    animateTileEffect(pid, tile, {
        className: isDenied ? "flash-denied" : "flash-denies",
        durationMs: DENY_LABEL_MS,
        durationProperty: "--deny-duration",
        timeoutMap: denyLabelTimeouts,
        color: getPlayerColor(event.target) || getPlayerColor(event.entity) || "#e2b12a",
        colorProperty: "--deny-color",
    });
}

function animatePenaltyEvent(event, tile = getPlayerTile(event?.entity)) {
    if (!event?.entity || event.type !== "penalty" || !tile) return;
    const pid = String(event.entity);
    animateTileEffect(pid, tile, {
        className: "flash-penalty",
        durationMs: PENALTY_LABEL_MS,
        durationProperty: "--penalty-duration",
        timeoutMap: penaltyLabelTimeouts,
        restart: true,
    });
}

function animateLifeState(pid, className) {
    const tile = getPlayerTile(pid);
    if (!tile) return;
    tile.classList.remove("life-depleted", "life-reloaded");
    animateTileEffect(String(pid), tile, {
        className,
        durationMs: LIFE_STATE_ANIMATION_MS,
        durationProperty: "--life-state-duration",
        timeoutMap: lifeStateAnimationTimeouts,
        restart: true,
    });
}

export function animateLiveLifeEvents(events) {
    const lifeEventsByPlayer = new Map();
    (Array.isArray(events) ? events : [events]).forEach((event) => {
        if (!event?.entity || !["reload", "tagged", "team-killed", "team-denied"].includes(event.type)) {
            return;
        }
        const pid = String(event.entity);
        if (!lifeEventsByPlayer.has(pid)) lifeEventsByPlayer.set(pid, []);
        lifeEventsByPlayer.get(pid).push(event);
    });

    lifeEventsByPlayer.forEach((lifeEvents, pid) => {
        const className = getLatestLifeAnimation(pid, lifeEvents);
        if (className) animateLifeState(pid, className);
    });
}

function getLatestLifeAnimation(pid, events, windowStart = -Infinity, windowEnd = Infinity) {
    let className = "";
    events.forEach((event) => {
        const eventTime = Number(event.time);
        if (!Number.isFinite(eventTime) || eventTime <= windowStart || eventTime > windowEnd) return;
        if (event.type === "reload") {
            className = "life-reloaded";
            return;
        }
        if (!["tagged", "team-killed", "team-denied"].includes(event.type)) return;
        const livesBefore = computePlayerLives(pid, Math.max(0, eventTime - 0.001));
        const livesAfter = computePlayerLives(pid, eventTime);
        if (livesBefore > 0 && livesAfter === 0) className = "life-depleted";
    });
    return className;
}

export function animateLiveShotEvents(events) {
    const shotEvents = Array.isArray(events) ? events : [events];
    const shooters = new Set(
        shotEvents
            .filter((event) => event && SHOT_EVENT_TYPES.has(event.type) && event.entity)
            .map((event) => String(event.entity))
    );

    shooters.forEach((pid) => {
        const tile = getPlayerTile(pid);
        if (!tile) return;
        animateTileEffect(pid, tile, {
            className: "shot-fired",
            durationMs: SHOT_ANIMATION_MS,
            durationProperty: "--shot-duration",
            timeoutMap: shotAnimationTimeouts,
            restart: true,
        });
    });

    const latestDenyEventByPlayer = new Map();
    shotEvents.forEach((event) => {
        if (!event?.entity || !getDenyEventPresentation(event)) return;
        const pid = String(event.entity);
        const previous = latestDenyEventByPlayer.get(pid);
        if (!previous || Number(event.time) >= Number(previous.time)) {
            latestDenyEventByPlayer.set(pid, event);
        }
    });
    latestDenyEventByPlayer.forEach((event) => animateDenyEvent(event));
}

export function animateLivePenaltyEvents(events) {
    const latestPenaltyByPlayer = new Map();
    (Array.isArray(events) ? events : [events]).forEach((event) => {
        if (!event?.entity || event.type !== "penalty") return;
        const pid = String(event.entity);
        const previous = latestPenaltyByPlayer.get(pid);
        if (!previous || Number(event.time) >= Number(previous.time)) {
            latestPenaltyByPlayer.set(pid, event);
        }
    });
    latestPenaltyByPlayer.forEach((event) => animatePenaltyEvent(event));
}

export function animateLiveBaseEvents(events) {
    const latestBaseEventByPlayer = new Map();
    (Array.isArray(events) ? events : [events]).forEach((event) => {
        if (!event?.entity || (event.type !== "base hit" && event.type !== "base destroy")) {
            return;
        }
        const pid = String(event.entity);
        const previous = latestBaseEventByPlayer.get(pid);
        if (
            !previous ||
            Number(event.time) > Number(previous.time) ||
            (Number(event.time) === Number(previous.time) && event.type === "base destroy")
        ) {
            latestBaseEventByPlayer.set(pid, event);
        }
    });

    latestBaseEventByPlayer.forEach((event, pid) => {
        const tile = getPlayerTile(pid);
        if (!tile) return;

        const isDestroy = event.type === "base destroy";
        tile.classList.remove("flash-base-hit", "flash-base-destroy");
        void tile.offsetWidth;
        animateTileEffect(pid, tile, {
            className: isDestroy ? "flash-base-destroy" : "flash-base-hit",
            durationMs: isDestroy ? BASE_DESTROY_FLASH_MS : BASE_HIT_FLASH_MS,
            durationProperty: "--flash-duration",
            timeoutMap: baseHitFlashTimeouts,
            color: getBaseEventColor(event),
        });
    });
}

export function updatePlayerTiles(currentTime) {
    // Live playback stops at the wall-clock edge between messages. Do not
    // cancel an in-flight effect when the next live delta arrives immediately
    // afterwards (for example, tag followed by deactivated).
    if (!state.isPlaying && !isLiveGameSelected()) {
        [baseHitFlashTimeouts, denyLabelTimeouts, penaltyLabelTimeouts, shotAnimationTimeouts, lifeStateAnimationTimeouts].forEach((timeouts) => {
            timeouts.forEach((timeoutId) => clearTimeout(timeoutId));
            timeouts.clear();
        });
        lastTileUpdateTime = -Infinity;
        document.querySelectorAll(".player-summary").forEach((tile) => {
            tile.classList.remove(
                "flash-base-hit",
                "flash-base-destroy",
                "flash-denies",
                "flash-denied",
                "flash-penalty",
                "shot-fired",
                "life-depleted",
                "life-reloaded"
            );
            ["--flash-color", "--flash-duration", "--deny-color", "--deny-duration", "--penalty-duration", "--shot-duration", "--life-state-duration"]
                .forEach((property) => tile.style.removeProperty(property));
        });
    }
    const timeJump =
        lastTileUpdateTime !== -Infinity &&
        Math.abs(currentTime - lastTileUpdateTime) > 1.5;
    const flashWindowStart =
        lastTileUpdateTime === -Infinity || !state.isPlaying || timeJump
            ? currentTime
            : lastTileUpdateTime;
    const focusPid =
        state.selectedPlayers && state.selectedPlayers.size === 1
        ? Array.from(state.selectedPlayers)[0]
        : null;
    const baseRunPlan = getCurrentBaseRunLayoutPlan(
        (state.gameData?.teams || []).map((team) => team.id),
        currentTime
    );
    const duration = getGameDuration(state.gameData);
    const liveGameSelected = isLiveGameSelected();
    const showAllPlayersActive = duration > 0 &&
        !liveGameSelected &&
        currentTime >= duration - 0.01;
    const killStreaks = new Map(
        Object.keys(state.gameData?.players || {}).map((playerId) => [
            playerId,
            computeKillStreak(playerId, currentTime),
        ])
    );
    const gameBestKillStreak = showAllPlayersActive
        ? Math.max(0, ...[...killStreaks.values()].map((streak) => streak.best))
        : 0;
    const gameBestKillStreakCount = showAllPlayersActive && gameBestKillStreak > 0
        ? [...killStreaks.values()].filter(
            (streak) => streak.best === gameBestKillStreak
        ).length
        : 0;

    document.querySelectorAll(".player-summary").forEach((tile) => {
        const pid = tile.dataset.playerId;
        tile.classList.remove(
            "tag-breakdown-hide-team-kills",
            "tag-breakdown-hide-bases"
        );
        const events = state.playerEvents[pid] || [];
        let score = events.length ? 0 : Number(state.gameData.players[pid]?.score) || 0;
        let isActive = true;
        let latestBaseEvent = null;
        let latestDenyEvent = null;
        let latestPenaltyEvent = null;
        let latestShotEvent = null;
        let penaltyCount = 0;
        let penaltyScoreDelta = 0;
        for (const ev of events) {
            if (ev.time > currentTime) break;
            const scoreDelta = Number(ev.delta) || 0;
            score += scoreDelta;
            if (ev.type === "penalty") {
                penaltyCount++;
                penaltyScoreDelta += scoreDelta;
            }
            if (ev.type === "deactivated") isActive = false;
            if (ev.type === "reactivated") isActive = true;
            if (SHOT_EVENT_TYPES.has(ev.type)) latestShotEvent = ev;
            if (getDenyEventPresentation(ev)) latestDenyEvent = ev;
            if (ev.type === "penalty") latestPenaltyEvent = ev;
            if (ev.type === "base hit" || ev.type === "base destroy") {
                if (
                    !latestBaseEvent ||
                    ev.time > latestBaseEvent.time ||
                    (ev.time === latestBaseEvent.time &&
                        ev.type === "base destroy" &&
                        latestBaseEvent.type !== "base destroy")
                ) {
                    latestBaseEvent = ev;
                }
            }
        }
        const scoreEl = tile.querySelector(".player-score");
        if (scoreEl) scoreEl.textContent = score.toLocaleString();
        tile.classList.toggle("_negative", score < 0);
        tile.classList.toggle("is-deactivated", !isActive && !showAllPlayersActive);

        const {
            tagsFor,
            tagsAgainst,
            tagsByTeam,
            ratioText,
            deniesCount,
            teamKillsFor,
            teamKillsAgainst,
        } = computePlayerStats(pid, currentTime);
        const killStreak = killStreaks.get(pid) || { current: 0, best: 0 };

        const tagsEl = tile.querySelector(".detail-tags");
        const tagsLabelEl = tile.querySelector(".detail-tags-label");
        const livesLineEl = tile.querySelector(".detail-lives-line");
        const livesEl = tile.querySelector(".detail-lives");
        const ratioEl = tile.querySelector(".detail-ratio");
        const deniesEl = tile.querySelector(".detail-denies");
        const uptimeEl = tile.querySelector(".detail-uptime");
        const killStreakEl = tile.querySelector(".kill-streak-indicator");

        if (killStreakEl) {
            const displayedStreak = showAllPlayersActive
                ? killStreak.best
                : killStreak.current;
            const showStreak = showAllPlayersActive ||
                displayedStreak >= KILL_STREAK_THRESHOLD;
            const isGameLeader = showAllPlayersActive && gameBestKillStreak > 0 &&
                killStreak.best === gameBestKillStreak;
            killStreakEl.hidden = !showStreak;
            killStreakEl.querySelector(".kill-streak-count").textContent =
                displayedStreak.toLocaleString();
            const streakLabel = showAllPlayersActive
                ? `Best kill streak: ${killStreak.best}${
                    isGameLeader
                        ? gameBestKillStreakCount > 1
                            ? "; tied for #1 this game"
                            : "; #1 this game"
                        : ""
                }`
                : `Current kill streak: ${killStreak.current}; ` +
                    `best so far: ${killStreak.best}`;
            killStreakEl.setAttribute("aria-label", streakLabel);
            killStreakEl.title = streakLabel;
            killStreakEl.classList.toggle(
                "kill-streak-blazing",
                liveGameSelected && killStreak.current >= LIVE_KILL_STREAK_GLOW_THRESHOLD
            );
            tile.classList.toggle("kill-streak-final", showAllPlayersActive);
            tile.classList.toggle("kill-streak-leader", isGameLeader);
        }

        if (livesEl) {
            const lifeTimeline = buildPlayerLifeTimeline(pid);
            const configuredLives = lifeTimeline?.[0]?.lives;
            let lives = configuredLives ?? null;
            for (const point of lifeTimeline || []) {
                if (point.time > currentTime) break;
                lives = point.lives;
            }
            const showLifeState = !showAllPlayersActive;
            const hasLivesMeter = showLifeState &&
                Number.isFinite(configuredLives) && configuredLives > 0;
            const meterWidth = hasLivesMeter
                ? `${Math.max(0, Math.min(100, (lives / configuredLives) * 100))}%`
                : "";
            const previousMeterWidth = tile.style.getPropertyValue("--lives-meter-width");

            livesEl.textContent = lives === null ? "–" : lives.toLocaleString();
            if (livesLineEl) livesLineEl.hidden = lives === null;
            tile.classList.toggle("is-out-of-lives", showLifeState && lives === 0);
            tile.classList.toggle("has-lives-meter", hasLivesMeter);
            tile.classList.toggle("life-meter-animated", hasLivesMeter && state.isPlaying);
            if (hasLivesMeter) {
                if (previousMeterWidth && previousMeterWidth !== meterWidth) {
                    tile.style.setProperty("--previous-lives-meter-width", previousMeterWidth);
                }
                tile.style.setProperty("--lives-meter-width", meterWidth);
            } else {
                tile.style.removeProperty("--lives-meter-width");
                tile.style.removeProperty("--previous-lives-meter-width");
            }

            if (!showLifeState) {
                const timeoutId = lifeStateAnimationTimeouts.get(pid);
                if (timeoutId) clearTimeout(timeoutId);
                lifeStateAnimationTimeouts.delete(pid);
                tile.classList.remove("life-depleted", "life-reloaded");
                tile.style.removeProperty("--life-state-duration");
            } else if (state.isPlaying && flashWindowStart < currentTime) {
                const className = getLatestLifeAnimation(
                    pid,
                    events,
                    flashWindowStart,
                    currentTime
                );
                if (className) animateLifeState(pid, className);
            }
        }
        if (tagsEl) {
        if (focusPid && focusPid !== pid) {
            const headToHead = computeHeadToHeadTags(focusPid, pid, currentTime);
            tagsEl.innerHTML =
            `${tagsFor} – ${tagsAgainst} ` +
            `<span class="detail-tags-h2h">(${headToHead.tagsFor} – ${headToHead.tagsAgainst})</span>`;
            if (tagsLabelEl) tagsLabelEl.textContent = "Tags:";
        } else {
            tagsEl.innerHTML =
            `${tagsFor} – ${tagsAgainst} ` +
            `<span class="detail-tags-teamKills">(${teamKillsFor} – ${teamKillsAgainst})</span>`;
            if (state.selectedPlayers?.has(pid)) {
                appendPlayerTagColourBreakdown(tagsEl, pid, tagsByTeam);
            }
        }
        }
        if (ratioEl) ratioEl.textContent = ratioText;
        if (deniesEl) deniesEl.textContent = deniesCount;
        if (uptimeEl) {
        const uptime = computePlayerUptime(pid, currentTime);
        const pct = Math.round(uptime * 100);
        uptimeEl.textContent = `${pct}%`;
        }
        const myTeamId = normaliseText(state.gameData.players[pid]?.team);
        const baseStats = computeBaseStats(pid, currentTime);
        const teamColorById = Object.fromEntries(
            state.gameData.teams.map((t) => [normaliseText(t.id), t.color])
        );
        let activeBases = (state.gameData.active_bases || []).filter(
            (base) => base && base.entityId && normaliseText(base.team) !== myTeamId
        );
        const assignedBaseTargetKey = baseRunPlan?.baseTargetKeyByTeamId?.[myTeamId] || "";
        if (assignedBaseTargetKey) {
            activeBases = activeBases.filter(
                (base) => baseMatchesTargetKey(base, assignedBaseTargetKey)
            );
        }
        const container = tile.querySelector(".detail-bases");

        if (container) {
        const basesMarkup = activeBases
            .map(({ entityId, team, color }) => {
            // Match timeline markers: bases represent their owning Comp team,
            // even when the physical base has a different colour.
            const baseColor = teamColorById[normaliseText(team)] || color || team;
            const stat = baseStats[normaliseText(entityId)] || {
                count: 0,
                destroyCount: 0,
                destroyed: false,
            };
            const destroyBadge = stat.destroyCount > 1
                ? `<span class="base-destroy-count"
                    aria-label="Destroyed ${stat.destroyCount} ${stat.destroyCount === 1 ? "time" : "times"}"
                    style="color:${baseColor};">${stat.destroyCount}</span>`
                : "";
            return `
        <div class="base-box${stat.destroyed ? " filled" : ""}"
            style="
                border-color: ${baseColor};
                ${stat.destroyed ? `background:${baseColor}; color:#ffffff;` : ""}
            ">
            <span class="base-hit-count">${stat.count > 0 ? stat.count : ""}</span>
            ${destroyBadge}
        </div>
        `;
            })
            .join("");
        const penaltyLabel = penaltyCount === 1 ? "Penalty" : `${penaltyCount} penalties`;
        const penaltyMarkup = penaltyCount > 0
            ? `<span class="penalty-card" role="img"
                aria-label="${penaltyLabel}: ${penaltyScoreDelta.toLocaleString()} points"
                title="${penaltyLabel}: ${penaltyScoreDelta.toLocaleString()} points">${
                    penaltyCount > 1 ? penaltyCount : ""
                }</span>`
            : "";
        container.innerHTML = basesMarkup + penaltyMarkup;
        }

        if (state.isPlaying && latestBaseEvent && latestBaseEvent.time > flashWindowStart) {
            const durationMs =
                latestBaseEvent.type === "base destroy"
                    ? BASE_DESTROY_FLASH_MS
                    : BASE_HIT_FLASH_MS;
            const className =
                latestBaseEvent.type === "base destroy"
                    ? "flash-base-destroy"
                    : "flash-base-hit";
            animateTileEffect(pid, tile, {
                className,
                durationMs,
                durationProperty: "--flash-duration",
                timeoutMap: baseHitFlashTimeouts,
                color: getBaseEventColor(latestBaseEvent),
            });
        }
        if (state.isPlaying && latestDenyEvent && latestDenyEvent.time > flashWindowStart) {
            animateDenyEvent(latestDenyEvent, tile);
        }
        if (state.isPlaying && latestPenaltyEvent && latestPenaltyEvent.time > flashWindowStart) {
            animatePenaltyEvent(latestPenaltyEvent, tile);
        }
        if (state.isPlaying && latestShotEvent && latestShotEvent.time > flashWindowStart) {
            animateTileEffect(pid, tile, {
                className: "shot-fired",
                durationMs: SHOT_ANIMATION_MS,
                durationProperty: "--shot-duration",
                timeoutMap: shotAnimationTimeouts,
                restart: true,
            });
        }
    });

    fitPlayerTagBreakdowns();
    fitBaseHitCounts();
    lastTileUpdateTime = currentTime;
}

function appendPlayerTagColourBreakdown(tagsEl, pid, tagsByTeam) {
    const playerTeamId = String(state.gameData?.players?.[pid]?.team ?? "");
    const opponents = (state.gameData?.teams || []).filter(
        (team) => String(team.id) !== playerTeamId
    );
    if (!opponents.length) return;

    const breakdownEl = document.createElement("span");
    breakdownEl.className = "detail-tags-by-colour";
    const accessibleBreakdown = [];
    opponents.forEach((team) => {
        const opponentId = String(team.id);
        const opponentStats = tagsByTeam?.[opponentId] || {};
        const tagsFor = Number(opponentStats.tagsFor) || 0;
        const opponentName = team.name || team.colorName || opponentId;
        const opponentEl = document.createElement("span");
        opponentEl.className = "detail-tags-opponent";
        opponentEl.dataset.teamId = opponentId;
        opponentEl.style.setProperty("--tag-team-colour", team.color || "#a2a2a2");
        opponentEl.textContent = String(tagsFor);
        opponentEl.title = `${opponentName}: ${tagsFor} tag${tagsFor === 1 ? "" : "s"} for`;
        breakdownEl.append(opponentEl);
        accessibleBreakdown.push(`${opponentName}: ${tagsFor}`);
    });
    breakdownEl.setAttribute(
        "aria-label",
        `Tags for by opponent colour: ${accessibleBreakdown.join("; ")}`
    );
    tagsEl.append(breakdownEl);
}

export function generatePlayerTiles() {
    const grid = document.getElementById("playerGrid");
    grid.innerHTML = "";
    lastTileUpdateTime = -Infinity;
    const ids = Object.keys(state.gameData.playerStats);

    ids.forEach((pid) => {
        const stats = state.gameData.playerStats[pid] || {};
        const tile = document.createElement("div");
        tile.classList.add("player-summary");
        tile.classList.add("expanded");
        tile.dataset.playerId = pid;
        tile.innerHTML = `
        <span class="player-lives-meter" aria-hidden="true"></span>
        <span class="player-event-label base-event-label base-hit-label" aria-hidden="true">BASE HIT</span>
        <span class="player-event-label base-event-label base-destroy-label" aria-hidden="true">BASE DESTROY</span>
        <span class="player-event-label deny-event-label denies-label" aria-hidden="true">DENY</span>
        <span class="player-event-label deny-event-label denied-label" aria-hidden="true">DENIED</span>
        <span class="player-event-label penalty-event-label" aria-hidden="true">⚠️ TERM</span>
        <div class="player-summary-header">
            <div class="player-name"><span class="kill-streak-indicator" hidden><svg class="kill-streak-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.3 1.5c.4 4.1 4.9 5.8 5.5 10.1.3 2.2-.4 4.5-2 6.2a5.4 5.4 0 0 0-2.6-5.1c.2 2.1-.4 3.5-1.5 4.7-.8-1.5-1-3.1-.4-5-2.4 1.8-3.6 3.8-3.3 5.9A7.5 7.5 0 0 1 6 8.2c1.2-1.5 2.7-2.7 4.4-4.5.2 2 .7 3.4 1.7 4.5.8-2 .8-4.2.2-6.7Z"/></svg><span class="kill-streak-count">0</span></span><span class="player-name-text">${stats.name || "–"}</span></div>
            <div class="player-score">${stats.score ?? "0"}</div>
        </div>
        <div class="player-summary-details">
            <div class="detail-left">
                <p class="detail-lives-line"><span class="detail-lives-label">Lives:</span> <span class="detail-lives">–</span></p>
                <p class="detail-tags-line"><span class="detail-tags-label">Tags:</span> <span class="detail-tags">–</span></p>
                <div class="detail-bases"></div>
            </div>
            <div class="detail-right">
                <div class="detail-combat-line">
                    <p class="detail-ratio-line"><span class="detail-ratio-label">TR:</span> <span class="detail-ratio">–</span></p>
                    <p class="detail-denies-line"><span class="detail-denies-label">Denies:</span> <span class="detail-denies">–</span></p>
                </div>
                <p class="detail-uptime-line">Uptime: <span class="detail-uptime">–</span></p>
            </div>
        </div>
        `;

        const player = state.gameData.players[pid];
        if (player) {
            const color = getPlayerColor(pid);
            tile.querySelector(".player-name").style.color = color;
            if (color) {
                tile.style.setProperty("--shot-color", color);
                tile.style.setProperty("--kill-streak-color", color);
            }
        }

        grid.appendChild(tile);
    });

    updatePlayerTiles(state.currentTime);
    stopTileOrderChecks();
    updateTileOrder();
    observeTileSizes(updatePlayerTileOrder);
    tileOrderCheckIntervalId = setInterval(updateTileOrder, TILE_ORDER_CHECK_INTERVAL_MS);
}

export function stopTileOrderChecks() {
    stopObservingTileSizes();
    if (tileOrderCheckIntervalId !== null) {
        clearInterval(tileOrderCheckIntervalId);
        tileOrderCheckIntervalId = null;
    }
    lastPlayerTileOrderSignature = "";
    lastPlayerLayoutSignature = "";
    lastTeamTileOrderSignature = "";
}

export function setupTeamSeriesFilter() {
    const items = document.querySelectorAll(".team-scores li");
    items.forEach((el) => el.classList.remove("active-team-filter"));
    items.forEach((li) => {
        li.style.cursor = "pointer";
        li.addEventListener("click", () => {
            const teamId = li.dataset.teamId;
            if (!teamId) return;
            toggleTeamVisibility(teamId);
            const inactiveTeams = state.hiddenTeams || new Set();
            items.forEach((item) => {
                item.classList.toggle("inactive-team-filter", inactiveTeams.has(item.dataset.teamId));
            });
        });
    });

}

export function applySelectedTileState() {
    if (!state.gameData) return;

    const validPlayerIds = new Set(Object.keys(state.gameData.players || {}));
    state.selectedPlayers = new Set(
        [...state.selectedPlayers].filter((playerId) => validPlayerIds.has(playerId))
    );

    const validTeamIds = new Set((state.gameData.teams || []).map((team) => String(team.id)));
    const hiddenTeamIds = state.selectedPlayers.size
        ? new Set(validTeamIds)
        : new Set(
            [...(state.hiddenTeams || [])]
                .map(String)
                .filter((teamId) => validTeamIds.has(teamId))
        );
    setHiddenTeams(hiddenTeamIds);

    document.querySelectorAll(".player-summary").forEach((tile) => {
        const playerId = tile.dataset.playerId;
        const selected = state.selectedPlayers.has(playerId);
        tile.classList.toggle("selected", selected);
        tile.style.borderColor = selected ? getPlayerHighlightColor(playerId) : "";
    });
    document.querySelectorAll(".team-scores li").forEach((tile) => {
        tile.classList.toggle(
            "inactive-team-filter",
            Boolean(state.hiddenTeams?.has(tile.dataset.teamId))
        );
    });

    updatePlayerSeriesDisplay();
    updatePlayerTiles(state.currentTime);
}

export function updateTeamScoresUI() {
    if (!state.chart) return;

    Object.entries(state.teamScores).forEach(([teamId, stats]) => {
        const li = document.querySelector(
        `.team-scores li[data-team-id="${teamId}"]`
        );
        const name = li?.querySelector(".team-name");
        const scoreSpan = li?.querySelector(".team-score");
        const tagsSpan = li?.querySelector(".team-tags")
        if (!name || !scoreSpan) return;

        scoreSpan.textContent = stats.score.toLocaleString();
        if (tagsSpan) updateTeamTags(tagsSpan, teamId, stats);
        const team = state.gameData.teams.find(t => t.id === teamId);
        const color = team ? team.color : "";
        name.style.color = color;
    });
}

function updateTeamTags(tagsEl, teamId, stats) {
    let totalEl = tagsEl.querySelector(".team-tags-total");
    let breakdownEl = tagsEl.querySelector(".team-tags-by-colour");
    if (!totalEl || !breakdownEl) {
        totalEl = document.createElement("span");
        totalEl.className = "team-tags-total";
        breakdownEl = document.createElement("span");
        breakdownEl.className = "team-tags-by-colour";
        tagsEl.replaceChildren(totalEl, breakdownEl);
    }

    const tagsFor = Number(stats.tagsFor) || 0;
    const tagsAgainst = Number(stats.tagsAgainst) || 0;
    totalEl.textContent = `${tagsFor}\u2009–\u2009${tagsAgainst}`;
    totalEl.title = `Total tags: ${tagsFor} for, ${tagsAgainst} against`;

    const opponents = (state.gameData?.teams || []).filter(
        (team) => String(team.id) !== String(teamId)
    );
    const signature = opponents.map((team) => String(team.id)).join("|");
    if (breakdownEl.dataset.teams !== signature) {
        breakdownEl.dataset.teams = signature;
        breakdownEl.replaceChildren(...opponents.map((team) => {
            const opponentEl = document.createElement("span");
            opponentEl.className = "team-tags-opponent";
            opponentEl.dataset.teamId = String(team.id);
            opponentEl.style.setProperty("--tag-team-colour", team.color || "#a2a2a2");
            return opponentEl;
        }));
    }

    const accessibleBreakdown = [];
    opponents.forEach((team) => {
        const opponentId = String(team.id);
        const opponentStats = stats.tagsByTeam?.[opponentId] || {};
        const opponentTagsFor = Number(opponentStats.tagsFor) || 0;
        const opponentName = team.name || team.colorName || opponentId;
        const opponentEl = Array.from(breakdownEl.children).find(
            (candidate) => candidate.dataset.teamId === opponentId
        );
        if (!opponentEl) return;
        opponentEl.textContent = String(opponentTagsFor);
        opponentEl.title = `${opponentName}: ${opponentTagsFor} tag${
            opponentTagsFor === 1 ? "" : "s"
        } for`;
        accessibleBreakdown.push(`${opponentName}: ${opponentTagsFor}`);
    });
    tagsEl.setAttribute(
        "aria-label",
        `Total tags: ${tagsFor} for, ${tagsAgainst} against${
            accessibleBreakdown.length
                ? `; tags for by opponent colour: ${accessibleBreakdown.join("; ")}`
                : ""
        }`
    );
}

function updateTileOrder() {
    updatePlayerTileOrder();
    updateTeamTileOrder();
}

function updateTeamTileOrder() {
    const scores = document.querySelector(".team-scores");
    if (!scores || !state.gameData) return;
    const items = Array.from(scores.querySelectorAll("li[data-team-id]"));
    if (!items.length) return;
    const subgames = getCurrentBaseRunLayoutPlan(
        items.map((item) => item.dataset.teamId)
    )?.subgames || null;
    const sortedTeamIds = subgames ? subgames.flat() : getSortedTeamIds();
    const signature = subgames
        ? `base-run:${subgames
            .map((group) => group.map(String).join(","))
            .join(";")}`
        : `standard:${sortedTeamIds.map(String).join("|")}`;
    if (signature === lastTeamTileOrderSignature) return;
    const animate = lastTeamTileOrderSignature && !subgames &&
        !document.body.classList.contains("game-layout-resizing");
    lastTeamTileOrderSignature = signature;
    const sidebar = scores.closest(".scores-sidebar");

    animateReorder(items, animate ? TILE_REORDER_TRANSITION_MS : 0, () => {
        if (subgames) {
            scores.classList.add("base-run-score-subgames");
            sidebar?.classList.add("base-run-score-sidebar");
            scores.replaceChildren(...subgames.map((teamIds, subgameIndex) => {
                const group = document.createElement("div");
                group.className = "team-score-subgame";
                group.dataset.subgame = String(subgameIndex + 1);
                const teamNames = teamIds.map((teamId) =>
                    state.gameData.teams.find((team) => team.id === teamId)?.name || teamId
                );
                group.setAttribute("aria-label", `${teamNames.join(" versus ")} subgame totals`);
                group.style.gridTemplateColumns = `repeat(${teamIds.length}, minmax(0, 1fr))`;
                teamIds
                    .map((teamId) => scores.querySelector(`li[data-team-id="${teamId}"]`))
                    .filter(Boolean)
                    .forEach((item) => group.appendChild(item));
                return group;
            }));
            return;
        }

        scores.classList.remove("base-run-score-subgames");
        sidebar?.classList.remove("base-run-score-sidebar");
        scores.replaceChildren(...sortedTeamIds
            .map((id) => scores.querySelector(`li[data-team-id="${id}"]`))
            .filter(Boolean)
        );
    });
    fitTileContents();
}

function animateReorder(elements, transitionMs, reorder) {
    const oldRects = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
    elements.forEach((element) => {
        element.style.transition = "";
        element.style.transform = "";
    });
    reorder();
    if (!transitionMs) return;
    elements.forEach((element) => {
        const oldRect = oldRects.get(element);
        const newRect = element.getBoundingClientRect();
        const dx = oldRect.left - newRect.left;
        const dy = oldRect.top - newRect.top;
        if (!dx && !dy) return;

        element.style.transform = `translate(${dx}px,${dy}px)`;
        element.getBoundingClientRect();
        element.style.transition = `transform ${transitionMs}ms ease`;
        element.style.transform = "";
        element.addEventListener("transitionend", () => {
            element.style.transition = "";
        }, { once: true });
    });
}

function getSortedTeamIds(visibleTeamIds = null) {
    const teams = visibleTeamIds
        ? state.gameData.teams.filter((team) => visibleTeamIds.has(String(team.id)))
        : state.gameData.teams;
    const totals = Object.fromEntries(teams.map((team) => [
        team.id,
        computeTeamTotal(team.id, state.currentTime),
    ]));
    return teams
        .map((team) => team.id)
        .sort((a, b) => (totals[b] || 0) - (totals[a] || 0));
}

function parseScoreText(text) {
    const score = Number(String(text || "").replace(/,/g, ""));
    return Number.isFinite(score) ? score : 0;
}

export function getPlayerTileHeightBudget(grid, fallbackHeight = 0) {
    return Number(grid?.parentElement?.clientHeight) ||
        Number(grid?.clientHeight) || Number(fallbackHeight) || 0;
}

function getCurrentBaseRunLayoutPlan(teamIds, currentTime = state.currentTime) {
    return getBaseRunLayoutPlan({
        gameData: state.gameData,
        selectedGame: state.selectedGame,
        // Historical replays already have the complete event list. Use it to
        // infer stable subgame pairings instead of briefly splitting teams
        // into unreadably narrow singleton groups early in the replay.
        currentTime: isLiveGameSelected() ? currentTime : Infinity,
        teamIds,
        getTeamTotal: (teamId) => computeTeamTotal(teamId, currentTime),
        policy: getClash3BaseRunPolicy({
            gameData: state.gameData,
            selectedGame: state.selectedGame,
            events: state.events,
        }),
    });
}

export function updatePlayerTileOrder() {
    const grid = document.getElementById("playerGrid");
    if (!grid || !state.gameData) return;
    const tiles = Array.from(grid.querySelectorAll(".player-summary"));
    if (!tiles.length) return;

    const byTeam = {};
    tiles.forEach((tile) => {
        const teamId = state.gameData.players[tile.dataset.playerId].team;
        (byTeam[teamId] ||= []).push(tile);
    });
    const baseRunPlan = getCurrentBaseRunLayoutPlan(Object.keys(byTeam));
    const subgames = baseRunPlan?.subgames || null;
    const sortedTeamIds = subgames
        ? subgames.flat()
        : getSortedTeamIds(new Set(Object.keys(byTeam)));
    sortedTeamIds.forEach((teamId) => {
        (byTeam[teamId] || []).sort((a, b) =>
            parseScoreText(b.querySelector(".player-score")?.textContent) -
            parseScoreText(a.querySelector(".player-score")?.textContent)
        );
    });
    const orderedTiles = sortedTeamIds.flatMap((teamId) => byTeam[teamId] || []);
    const forceBaseRunTeamColumns = !!subgames &&
        window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
    const allowResponsiveBaseRunColumns =
        window.matchMedia("(orientation: landscape)").matches;
    const subgameWidth = subgames?.length ? grid.clientWidth / subgames.length : Infinity;
    const subgameLayouts = (subgames || []).map((teamIds) => {
        const maxTeamSize = Math.max(
            1,
            ...teamIds.map((teamId) => (byTeam[teamId] || []).length)
        );
        return {
            maxTeamSize,
            teamsAsColumns: shouldUseTeamColumns({
                forceTeamColumns: forceBaseRunTeamColumns,
                allowResponsiveColumns: allowResponsiveBaseRunColumns,
                teamCount: teamIds.length,
                maxTeamSize,
                subgameWidth,
                subgameHeight: grid.clientHeight,
            }),
        };
    });
    const standardTeamCount = sortedTeamIds.length;
    const standardMaxTeamSize = Math.max(
        1,
        ...sortedTeamIds.map((teamId) => (byTeam[teamId] || []).length)
    );
    const standardGridRowGap = Number.parseFloat(getComputedStyle(grid).rowGap) || 0;
    const standardGridColumnGap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
    // Include the grid container's scrollbar in the measured box so a reflow
    // that removes overflow cannot immediately reverse the width decision.
    const standardLayoutWidth = grid.parentElement?.offsetWidth ||
        grid.clientWidth;
    const standardUsableWidth = Math.max(
        0,
        standardLayoutWidth - standardGridColumnGap * (standardMaxTeamSize - 1)
    );
    // Measure the fixed game section, not the grid's content-driven height, so
    // changing orientation cannot immediately reverse its own layout decision.
    const standardLayoutHeight = grid.closest(".top-section")?.clientHeight ||
        grid.parentElement?.clientHeight || grid.clientHeight;
    // The outer pane includes top/results padding that is not available to
    // player cards. Its fixed grid container is the stable height budget for
    // compact-mode decisions; measuring the content-driven grid itself could
    // make the decision oscillate after a layout change.
    const playerGridHeight = getPlayerTileHeightBudget(grid, standardLayoutHeight);
    const standardUsableHeight = Math.max(
        0,
        playerGridHeight - standardGridRowGap * (standardMaxTeamSize - 1)
    );
    // Many small teams (for example doubles) must not become a column of
    // unreadable slivers each. Use team rows when those rows have enough room.
    const useNarrowTeamRows = standardTeamCount > standardMaxTeamSize &&
        (standardLayoutWidth - standardGridColumnGap * (standardTeamCount - 1)) /
            standardTeamCount < 96 &&
        (playerGridHeight - standardGridRowGap * (standardTeamCount - 1)) /
            standardTeamCount >= 26;
    const standardTeamsAsColumns = !subgames && !useNarrowTeamRows && shouldUseTeamColumns({
        allowResponsiveColumns: true,
        teamCount: standardTeamCount,
        maxTeamSize: standardMaxTeamSize,
        subgameWidth: standardUsableWidth,
        subgameHeight: standardUsableHeight,
        minimumTileWidth: STANDARD_MINIMUM_TILE_WIDTH,
        minimumTileHeight: STANDARD_MINIMUM_TILE_HEIGHT,
    });
    // Both the default and saved split use the space actually inside the pane.
    const standardHeightBudget = playerGridHeight;
    const standardRowCount = standardTeamsAsColumns
        ? standardMaxTeamSize
        : standardTeamCount;
    const standardCompactTiles = !subgames &&
        shouldUseCompactTeamTiles({
            maxTeamSize: standardRowCount,
            availableHeight: standardHeightBudget,
            rowGap: standardGridRowGap,
            minimumFullTileHeight: STANDARD_FULL_TILE_HEIGHT,
        });
    const baseRunRowCount = subgames
        ? Math.max(...subgameLayouts.map(({ maxTeamSize, teamsAsColumns }, index) =>
            teamsAsColumns ? maxTeamSize : subgames[index].length
        ))
        : 0;
    // Test the space required by full cards in both directions. Measuring
    // compact padding/gaps here makes density toggle on every observer frame
    // around the threshold, because compact mode creates extra usable space.
    const wasBaseRunCompact = grid.classList.contains("pane-compact-tiles");
    if (wasBaseRunCompact) grid.classList.remove("pane-compact-tiles");
    const renderedGroups = [...grid.querySelectorAll(".base-run-subgame")];
    const baseRunHeightBudget = renderedGroups.length
        ? Math.min(...renderedGroups.map((group) => {
            const style = getComputedStyle(group);
            return group.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        }))
        : playerGridHeight;
    const baseRunRowGap = renderedGroups.length
        ? Math.max(...renderedGroups.map((group) => parseFloat(getComputedStyle(group).rowGap) || 0))
        : standardGridRowGap;
    if (wasBaseRunCompact) grid.classList.add("pane-compact-tiles");
    const baseRunCompactTiles = !!subgames &&
        shouldUseCompactTeamTiles({
            maxTeamSize: baseRunRowCount,
            availableHeight: baseRunHeightBudget,
            rowGap: baseRunRowGap,
            minimumFullTileHeight: BASE_RUN_FULL_TILE_HEIGHT,
        });
    const layoutSignature = `${baseRunPlan?.id || "standard"}:${subgames
        ? subgames.map((group) => group.map(String).join(",")).join(";")
        : ""}:${subgames
            ? subgameLayouts.map(({ teamsAsColumns }) =>
                teamsAsColumns ? "team-columns" : "player-columns"
            ).join(",")
            : standardTeamsAsColumns ? "team-columns" : "player-columns"}:${
                standardCompactTiles ? "compact" : "full"
            }:${baseRunCompactTiles ? "pane-compact" : "pane-full"}`;
    const signature = `${layoutSignature}|${orderedTiles
        .map((tile) => `${state.gameData.players[tile.dataset.playerId].team}:${tile.dataset.playerId}`)
        .join("|")}`;
    // Scaled layouts keep a readable minimum card size and scroll within the
    // player pane when the requested scale exceeds the available space.
    const stackedSubgames = subgames && window.matchMedia("(orientation: portrait)").matches;
    const layoutColumns = subgames
        ? (stackedSubgames ? 1 : subgames.length) * Math.max(...subgameLayouts.map(({ maxTeamSize, teamsAsColumns }, index) =>
            teamsAsColumns ? subgames[index].length : maxTeamSize))
        : standardTeamsAsColumns ? standardTeamCount : standardMaxTeamSize;
    const layoutRows = subgames
        ? (stackedSubgames ? subgames.length : 1) * Math.max(...subgameLayouts.map(({ maxTeamSize, teamsAsColumns }, index) =>
            teamsAsColumns ? maxTeamSize : subgames[index].length))
        : standardRowCount;
    grid.style.setProperty("--player-layout-columns", layoutColumns);
    grid.style.setProperty("--player-layout-rows", layoutRows);
    if (signature === lastPlayerTileOrderSignature) {
        fitTileContents();
        return;
    }
    lastPlayerTileOrderSignature = signature;
    const layoutChanged = layoutSignature !== lastPlayerLayoutSignature;
    lastPlayerLayoutSignature = layoutSignature;

    const applyLayout = () => {
        if (subgames) {
            grid.classList.add("base-run-subgames");
            grid.classList.remove("standard-team-columns");
            grid.classList.remove("standard-compact-tiles");
            grid.classList.toggle("pane-compact-tiles", baseRunCompactTiles);
            grid.style.gridTemplateColumns = `repeat(${subgames.length}, minmax(0, 1fr))`;
            grid.style.gridTemplateRows = "auto";

            const groups = subgames.map((teamIds, subgameIndex) => {
                const group = document.createElement("div");
                group.className = "base-run-subgame";
                group.dataset.subgame = String(subgameIndex + 1);
                const teamNames = teamIds.map((teamId) =>
                    state.gameData.teams.find((team) => team.id === teamId)?.name || teamId
                );
                group.setAttribute("aria-label", `${teamNames.join(" versus ")} subgame`);

                const { maxTeamSize, teamsAsColumns } = subgameLayouts[subgameIndex];
                const columnCount = teamsAsColumns ? teamIds.length : maxTeamSize;
                const rowCount = teamsAsColumns ? maxTeamSize : teamIds.length;
                group.style.gridTemplateColumns = `repeat(${columnCount}, minmax(0, 1fr))`;
                group.style.gridTemplateRows = `repeat(${rowCount}, auto)`;
                teamIds.forEach((teamId, outerIndex) => {
                    (byTeam[teamId] || []).forEach((tile, innerIndex) => {
                        tile.style.gridColumn = (teamsAsColumns ? outerIndex : innerIndex) + 1;
                        tile.style.gridRow = (teamsAsColumns ? innerIndex : outerIndex) + 1;
                        group.appendChild(tile);
                    });
                });
                return group;
            });
            grid.replaceChildren(...groups);
            return;
        }

        grid.classList.remove("base-run-subgames");
        grid.classList.remove("pane-compact-tiles");
        grid.classList.toggle("standard-team-columns", standardTeamsAsColumns);
        grid.classList.toggle("standard-compact-tiles", standardCompactTiles);
        const columnCount = standardTeamsAsColumns
            ? standardTeamCount
            : standardMaxTeamSize;
        const rowCount = standardTeamsAsColumns
            ? standardMaxTeamSize
            : standardTeamCount;

        grid.style.gridTemplateColumns = `repeat(${columnCount}, minmax(0, 1fr))`;
        grid.style.gridTemplateRows = `repeat(${rowCount}, minmax(0, 1fr))`;
        sortedTeamIds.forEach((teamId, outerIndex) => {
            (byTeam[teamId] || []).forEach((tile, innerIndex) => {
                tile.style.gridColumn = (standardTeamsAsColumns ? outerIndex : innerIndex) + 1;
                tile.style.gridRow = (standardTeamsAsColumns ? innerIndex : outerIndex) + 1;
            });
        });

        orderedTiles.forEach((tile) => grid.appendChild(tile));
    };
    // Responsive row/column changes must take effect before paint. A FLIP
    // animation from the old pane geometry can cross a newly moved divider.
    if (layoutChanged || document.body.classList.contains("game-layout-resizing")) {
        tiles.forEach((tile) => {
            tile.style.transition = "";
            tile.style.transform = "";
        });
        applyLayout();
    } else {
        animateReorder(tiles, TILE_REORDER_TRANSITION_MS, applyLayout);
    }
    fitTileContents();
}

export function setupPlayerSeriesToggles() {
    document.querySelectorAll(".player-summary").forEach((tile) => {
        tile.addEventListener("click", (e) => {
            const clickedTile = e.currentTarget;

            const pid = clickedTile.dataset.playerId;
            if (state.isGameLoading || !state.gameData?.players?.[pid]) return;

            if (state.selectedPlayers.has(pid)) {
                state.selectedPlayers.delete(pid);
            } else {
                state.selectedPlayers.add(pid);
            }

            // Player focus replaces the team view.  Restore the initial team
            // selection once the last focused player is cleared.
            const hiddenTeamIds = state.selectedPlayers.size
                ? new Set(state.gameData.teams.map((team) => team.id))
                : null;
            setHiddenTeams(hiddenTeamIds);
            document.querySelectorAll(".team-scores li").forEach((teamTile) => {
                teamTile.classList.toggle(
                    "inactive-team-filter",
                    hiddenTeamIds?.has(teamTile.dataset.teamId) || false
                );
            });

            const isSelected = state.selectedPlayers.has(pid);
            clickedTile.classList.toggle("selected", isSelected);
            if (isSelected) {
                clickedTile.style.borderColor = getPlayerHighlightColor(pid);
            } else {
                clickedTile.style.borderColor = "";
            }
            updatePlayerSeriesDisplay();
            updatePlayerTiles(state.currentTime);
        });
    });
}
