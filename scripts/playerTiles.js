// playerTiles.js
import { buildPlayerLifeTimeline, computePlayerStats, computeBaseStats, computeTeamTotal, computeHeadToHeadTags, computePlayerUptime, computePlayerLives, getGameDuration, getPlayerHighlightColor, normaliseText } from "./utils.js";
import { baseMatchesTargetKey, getBaseRunLayoutPlan } from "./baseRun.js";
import { getClash3BaseRunPolicy } from "./events/clash3BaseRun.js";
import { isLiveGameSelected } from "./live.js";
import { state } from "./state.js";
import { updatePlayerSeriesDisplay, toggleTeamVisibility, setHiddenTeams } from "./timeline.js";
import { SHORT_LANDSCAPE_QUERY } from "./config.js";

const TILE_ORDER_CHECK_INTERVAL_MS = 300;
const TILE_REORDER_TRANSITION_MS = 240;
const BASE_HIT_FLASH_MS = 500;
const BASE_DESTROY_FLASH_MS = BASE_HIT_FLASH_MS * 2;
const DENY_LABEL_MS = 750;
const SHOT_ANIMATION_MS = 260;
const LIFE_STATE_ANIMATION_MS = 900;
const SHOT_EVENT_TYPES = new Set([
    "miss",
    "miss-base",
    "stun",
    "tag",
    "team-kill",
    "deny",
    "team-stun",
    "base hit",
    "base destroy",
]);
const baseHitFlashTimeouts = new Map();
const denyLabelTimeouts = new Map();
const shotAnimationTimeouts = new Map();
const lifeStateAnimationTimeouts = new Map();
let lastTileUpdateTime = -Infinity;
let tileOrderCheckIntervalId = null;
let lastTileOrderSignature = "";

function animateTileEffect(pid, tile, {
    className,
    durationMs,
    durationProperty,
    timeoutMap,
    color = "",
    colorProperty = "--flash-color",
    restart = false,
}) {
    const duration = Math.max(90, durationMs / (state.playbackRate || 1));
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

function animateDenyEvent(event, tile = getPlayerTile(event?.entity)) {
    if (!event?.entity || !tile || (event.type !== "deny" && event.type !== "denied")) return;
    const pid = String(event.entity);
    const isDenied = event.type === "denied";
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

function animateDenyEvents(events) {
    const latestDenyEventByPlayer = new Map();
    events.forEach((event) => {
        if (!event?.entity || (event.type !== "deny" && event.type !== "denied")) return;
        const pid = String(event.entity);
        const previous = latestDenyEventByPlayer.get(pid);
        if (!previous || Number(event.time) >= Number(previous.time)) {
            latestDenyEventByPlayer.set(pid, event);
        }
    });
    latestDenyEventByPlayer.forEach((event) => animateDenyEvent(event));
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
        if (!event?.entity || !["reload", "tagged", "team-killed"].includes(event.type)) {
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
        if (event.type !== "tagged" && event.type !== "team-killed") return;
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
        const tile = Array.from(document.querySelectorAll(".player-summary"))
            .find((candidate) => candidate.dataset.playerId === pid);
        if (!tile) return;
        animateTileEffect(pid, tile, {
            className: "shot-fired",
            durationMs: SHOT_ANIMATION_MS,
            durationProperty: "--shot-duration",
            timeoutMap: shotAnimationTimeouts,
            restart: true,
        });
    });

    animateDenyEvents(shotEvents);
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
        const tile = Array.from(document.querySelectorAll(".player-summary"))
            .find((candidate) => candidate.dataset.playerId === pid);
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
        [baseHitFlashTimeouts, denyLabelTimeouts, shotAnimationTimeouts, lifeStateAnimationTimeouts].forEach((timeouts) => {
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
                "shot-fired",
                "life-depleted",
                "life-reloaded"
            );
            ["--flash-color", "--flash-duration", "--deny-color", "--deny-duration", "--shot-duration", "--life-state-duration"]
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
    const showAllPlayersActive = duration > 0 &&
        !isLiveGameSelected() &&
        currentTime >= duration - 0.01;

    document.querySelectorAll(".player-summary").forEach((tile) => {
        const pid = tile.dataset.playerId;
        const events = state.playerEvents[pid] || [];
        let score = events.length ? 0 : Number(state.gameData.players[pid]?.score) || 0;
        let isActive = true;
        let latestBaseEvent = null;
        let latestDenyEvent = null;
        let latestShotEvent = null;
        for (const ev of events) {
            if (ev.time > currentTime) break;
            score += ev.delta ?? 0;
            if (ev.type === "deactivated") isActive = false;
            if (ev.type === "reactivated") isActive = true;
            if (SHOT_EVENT_TYPES.has(ev.type)) latestShotEvent = ev;
            if (ev.type === "deny" || ev.type === "denied") latestDenyEvent = ev;
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
        // update the tile
        const scoreEl = tile.querySelector(".player-score");
        if (scoreEl) scoreEl.textContent = score.toLocaleString();
        tile.classList.toggle("_negative", score < 0);
        tile.classList.toggle("is-deactivated", !isActive && !showAllPlayersActive);

        const { tagsFor, tagsAgainst, ratioText, deniesCount, teamKillsFor, teamKillsAgainst } =
        computePlayerStats(pid, currentTime);

        const tagsEl = tile.querySelector(".detail-tags");
        const tagsLabelEl = tile.querySelector(".detail-tags-label");
        const livesLineEl = tile.querySelector(".detail-lives-line");
        const livesEl = tile.querySelector(".detail-lives");
        const ratioEl = tile.querySelector(".detail-ratio");
        const deniesEl = tile.querySelector(".detail-denies");
        const uptimeEl = tile.querySelector(".detail-uptime");

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
            // Show head to head stats for other players if we have a focused player.
            const headToHead = computeHeadToHeadTags(focusPid, pid, currentTime);
            tagsEl.innerHTML =
            `${tagsFor} – ${tagsAgainst} ` +
            `<span class="detail-tags-h2h">(${headToHead.tagsFor} – ${headToHead.tagsAgainst})</span>`; // using thin spaces
            if (tagsLabelEl) tagsLabelEl.textContent = "Tags:";
        } else {
            tagsEl.innerHTML =
            `${tagsFor} – ${tagsAgainst} ` +
            `<span class="detail-tags-teamKills">(${teamKillsFor} – ${teamKillsAgainst})</span>`;
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
        container.innerHTML = activeBases
            .map(({ entityId, team, color }) => {
            // Match timeline markers: bases represent their owning Comp team,
            // even when the physical base has a different colour.
            const baseColor = teamColorById[normaliseText(team)] || color || team;
            // stat for this target:
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
            ${stat.count}
            ${destroyBadge}
        </div>
        `;
            })
            .join("");
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

    lastTileUpdateTime = currentTime;
}

export function generatePlayerTiles() {
    const grid = document.getElementById("playerGrid");
    grid.innerHTML = "";
    lastTileUpdateTime = -Infinity;
    lastTileOrderSignature = "";
    const ids = Object.keys(state.gameData.playerStats);

    ids.forEach((pid) => {
        const stats = state.gameData.playerStats[pid] || {};
        const tile = document.createElement("div");
        tile.classList.add("player-summary");
        tile.classList.add("expanded");
        tile.dataset.playerId = pid;
        tile.innerHTML = `
        <span class="player-event-label base-event-label base-hit-label" aria-hidden="true">BASE HIT</span>
        <span class="player-event-label base-event-label base-destroy-label" aria-hidden="true">BASE DESTROY</span>
        <span class="player-event-label deny-event-label denies-label" aria-hidden="true">DENIES</span>
        <span class="player-event-label deny-event-label denied-label" aria-hidden="true">DENIED</span>
        <div class="player-summary-header">
            <div class="player-name">${stats.name || "–"}</div>
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
            const team = state.gameData.teams.find(t => t.id === player.team);
            const color = team ? team.color : "";
            tile.querySelector(".player-name").style.color = color;
            if (color) tile.style.setProperty("--shot-color", color);
        }

        grid.appendChild(tile);
    });

    updatePlayerTiles(state.currentTime);
    stopPlayerTileOrderChecks();
    updatePlayerTileOrder();
    tileOrderCheckIntervalId = setInterval(updatePlayerTileOrder, TILE_ORDER_CHECK_INTERVAL_MS);
}

export function stopPlayerTileOrderChecks() {
    if (tileOrderCheckIntervalId !== null) {
        clearInterval(tileOrderCheckIntervalId);
        tileOrderCheckIntervalId = null;
    }
    lastTileOrderSignature = "";
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
        [...(state.selectedPlayers || [])].filter((playerId) => validPlayerIds.has(playerId))
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
        tagsSpan.textContent = `${stats.tagsFor} - ${stats.tagsAgainst}`;
        const team = state.gameData.teams.find(t => t.id === teamId);
        const color = team ? team.color : "";
        name.style.color = color;
    });

    const scores = document.querySelector(".team-scores");
    if (!scores) return;
    const items = Array.from(scores.querySelectorAll("li[data-team-id]"));
    const subgames = getCurrentBaseRunLayoutPlan(
        items.map((item) => item.dataset.teamId)
    )?.subgames || null;
    const sidebar = scores.closest(".scores-sidebar");

    animateReorder(items, 300, () => {
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
        scores.replaceChildren(...getSortedTeamIds()
            .map((id) => scores.querySelector(`li[data-team-id="${id}"]`))
            .filter(Boolean)
        );
    });
}

function animateReorder(elements, transitionMs, reorder) {
    const oldRects = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
    elements.forEach((element) => {
        element.style.transition = "";
        element.style.transform = "";
    });
    reorder();
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

function updatePlayerTileOrder() {
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
    const baseRunTeamsAsColumns = !!subgames &&
        window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
    const signature = `${baseRunPlan?.id || "standard"}:${subgames
        ? subgames.map((group) => group.map(String).join(",")).join(";")
        : ""}:${baseRunTeamsAsColumns ? "team-columns" : "compact"}|${orderedTiles
        .map((tile) => `${state.gameData.players[tile.dataset.playerId].team}:${tile.dataset.playerId}`)
        .join("|")}`;
    if (signature === lastTileOrderSignature) return;
    lastTileOrderSignature = signature;

    animateReorder(tiles, TILE_REORDER_TRANSITION_MS, () => {
        if (subgames) {
            grid.classList.add("base-run-subgames");
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

                const maxTeamSize = Math.max(
                    1,
                    ...teamIds.map((teamId) => (byTeam[teamId] || []).length)
                );
                const teamsAsColumns = baseRunTeamsAsColumns || teamIds.length >= maxTeamSize;
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
        const teamCount = sortedTeamIds.length;
        const maxTeamSize = Math.max(
            1,
            ...sortedTeamIds.map((teamId) => (byTeam[teamId] || []).length)
        );

        const teamsAsColumns = teamCount >= maxTeamSize;
        const columnCount = teamsAsColumns ? teamCount : maxTeamSize;
        const rowCount = teamsAsColumns ? maxTeamSize : teamCount;

        grid.style.gridTemplateColumns = `repeat(${columnCount}, minmax(0, 1fr))`;
        grid.style.gridTemplateRows = `repeat(${rowCount}, auto)`;
        sortedTeamIds.forEach((teamId, outerIndex) => {
            (byTeam[teamId] || []).forEach((tile, innerIndex) => {
                tile.style.gridColumn = (teamsAsColumns ? outerIndex : innerIndex) + 1;
                tile.style.gridRow = (teamsAsColumns ? innerIndex : outerIndex) + 1;
            });
        });

        orderedTiles.forEach((tile) => grid.appendChild(tile));
    });
}

export function setupPlayerSeriesToggles() {
    document.querySelectorAll(".player-summary").forEach((tile) => {
        tile.addEventListener("click", (e) => {
            const clickedTile = e.currentTarget;

            const pid = clickedTile.dataset.playerId;
            if ( state.isGameLoading || !state.gameData || !state.gameData.players || !state.gameData.players[pid] ) return; // ignore clicks while loading

            // toggle in the Set
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

            // sync chart to only show selected players
            updatePlayerSeriesDisplay();
            updatePlayerTiles(state.currentTime);
            clickedTile.classList.toggle("selected");

            // if selected, set the border to the highlight color
            const isSelected = clickedTile.classList.contains("selected");
            if (isSelected) {
                clickedTile.style.borderColor = getPlayerHighlightColor(pid);
            } else {
                // collapsed — reset to default
                clickedTile.style.borderColor = "";
            }
        });
    });
}
