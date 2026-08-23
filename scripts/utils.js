import { state } from "./state.js";
import { COARSE_POINTER_QUERY, GAME_TIMEZONE } from "./config.js";
import { getLivePresentationDelaySeconds } from "./liveDelay.js";

export const normaliseText = (value) => String(value ?? "").trim().toLowerCase();
export const LIVE_END_GRACE_SECONDS = 30;

const PLAYER_HIGHLIGHT_BACKGROUND = [30, 30, 30];
const MIN_PLAYER_HIGHLIGHT_CONTRAST = 3;

function readableHighlightLightness(hue, saturation, lightness) {
    const luminance = (rgb) => {
        const [red, green, blue] = rgb.map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const background = luminance(PLAYER_HIGHLIGHT_BACKGROUND);
    let adjusted = Math.max(0, Math.min(100, lightness));
    while (adjusted < 100) {
        const h = ((hue % 360) + 360) % 360 / 360;
        const s = saturation / 100;
        const l = adjusted / 100;
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const channel = (offset) => {
            if (s === 0) return l * 255;
            let value = h + offset;
            if (value < 0) value += 1;
            if (value > 1) value -= 1;
            if (value < 1 / 6) return (p + (q - p) * 6 * value) * 255;
            if (value < 1 / 2) return q * 255;
            if (value < 2 / 3) return (p + (q - p) * (2 / 3 - value) * 6) * 255;
            return p * 255;
        };
        const foreground = luminance([channel(1 / 3), channel(0), channel(-1 / 3)]);
        if ((Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05) >= MIN_PLAYER_HIGHLIGHT_CONTRAST) break;
        adjusted++;
    }
    return adjusted;
}

export function addSwipeRightListener(element, listener) {
    let start = null;
    const begin = (source, id, { clientX, clientY }) => {
        if (!start || source === "touch") start = { source, id, x: clientX, y: clientY };
    };
    const finish = (source, id, { clientX, clientY }) => {
        if (start?.source !== source || start.id !== id) return;
        const dx = clientX - start.x;
        const dy = clientY - start.y;
        start = null;
        if (dx >= 50 && Math.abs(dx) > Math.abs(dy) * 1.25) listener();
    };
    element.addEventListener("pointerdown", (event) => {
        if (event.isPrimary === false ||
            (event.pointerType === "mouse" && !window.matchMedia(COARSE_POINTER_QUERY).matches)) return;
        begin("pointer", event.pointerId, event);
    });
    element.addEventListener("pointerup", (event) => finish("pointer", event.pointerId, event));
    element.addEventListener("pointercancel", () => {
        if (start?.source === "pointer") start = null;
    });
    element.addEventListener("touchstart", (event) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        begin("touch", touch.identifier, touch);
    }, { passive: true });
    element.addEventListener("touchend", (event) => {
        const touch = Array.from(event.changedTouches).find(({ identifier }) => identifier === start?.id);
        if (touch) finish("touch", touch.identifier, touch);
    }, { passive: true });
    element.addEventListener("touchcancel", () => {
        if (start?.source === "touch") start = null;
    }, { passive: true });
}

export function hexToRGBA(hex, alpha) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

export function formatTime(sec) {
    const total = Math.floor(sec);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function getPlayerHighlightColor(pid) {
    const players = Object.keys(state.gameData.players || {}).sort();
    const index = players.indexOf(pid);
    if (index === -1) return "#e2b12a";

    const player = state.gameData.players[pid];
    const teammates = players.filter(
        (id) => String(state.gameData.players[id]?.team) === String(player?.team)
    );
    const team = state.gameData.teams?.find(
        (item) => String(item.id) === String(player?.team)
    );
    const match = typeof team?.color === "string"
        ? team.color.trim().match(/^#([0-9a-f]{6})$/i)
        : null;

    // Team-game highlights stay close to the team colour but remain distinct.
    if (teammates.length > 1 && match) {
        const rgb = [0, 2, 4].map((offset) => parseInt(match[1].slice(offset, offset + 2), 16) / 255);
        const max = Math.max(...rgb);
        const min = Math.min(...rgb);
        const delta = max - min;
        let hue = 0;
        if (delta) {
            if (max === rgb[0]) hue = 60 * (((rgb[1] - rgb[2]) / delta) % 6);
            else if (max === rgb[1]) hue = 60 * ((rgb[2] - rgb[0]) / delta + 2);
            else hue = 60 * ((rgb[0] - rgb[1]) / delta + 4);
        }
        if (hue < 0) hue += 360;
        const lightness = (max + min) / 2;
        const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
        const centeredIndex = teammates.indexOf(pid) - (teammates.length - 1) / 2;
        const adjustedSaturation = Math.max(45, Math.round(saturation * 100));
        const adjustedHue = Math.round((hue + centeredIndex * 16 + 360) % 360);
        const adjustedLightness = readableHighlightLightness(
            adjustedHue,
            adjustedSaturation,
            Math.max(34, Math.min(78,
                Math.round(lightness * 100) +
                (centeredIndex === 0 ? 0 : centeredIndex < 0 ? 10 : -10)
            )),
        );
        return `hsl(${adjustedHue}, ${adjustedSaturation}%, ${adjustedLightness}%)`;
    }

    const hue = (index / players.length) * 360;
    return `hsl(${hue}, 70%, ${readableHighlightLightness(hue, 70, 60)}%)`;
}

export function getGameDuration(data = state.gameData) {
    if (!data) return 0;
    const explicitDuration = Number(data.gameDuration);
    if (Number.isFinite(explicitDuration) && explicitDuration > 0) return explicitDuration;
    const maxEventTime = Math.max(0, ...(data.events || []).map((e) => Number(e.time) || 0));
    return maxEventTime;
}

export function parseGameStart(game, timezone = GAME_TIMEZONE) {
    if (!game || !game.id) return null;
    const m = game.id.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/);
    if (!m) return null;
    const [, YYYY, MM, DD, hh, mm, ss = "00"] = m;
    const parsed = new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:${ss}${timezone}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getScheduledGameLiveDeadline(game) {
    if (!game) return null;
    const duration = Number(game.gameDuration);
    if (!Number.isFinite(duration) || duration <= 0) return null;

    const idStart = parseGameStart(game);
    const explicitStart = game.startTime ? new Date(game.startTime) : null;
    const start = idStart || (
        explicitStart && !Number.isNaN(explicitStart.getTime()) &&
        explicitStart.getUTCFullYear() > 2000
            ? explicitStart
            : null
    );
    if (!start) return null;
    return new Date(start.getTime() + (duration + LIVE_END_GRACE_SECONDS) * 1000);
}

export function isPastScheduledGameLiveDeadline(game, now = Date.now()) {
    const deadline = getScheduledGameLiveDeadline(game);
    const currentTime = now instanceof Date ? now.getTime() : Number(now);
    return Boolean(
        deadline &&
        Number.isFinite(currentTime) &&
        currentTime >= deadline.getTime()
    );
}

export function markGameNonLiveAfterDeadline(game, now = Date.now()) {
    return game?.live === true && isPastScheduledGameLiveDeadline(game, now)
        ? { ...game, live: false }
        : game;
}

export function getLivePresentationTime(data, game = data) {
    const duration = getGameDuration(data);
    const explicitStart = data?.startTime ? new Date(data.startTime) : null;
    const start = parseGameStart(game || data) ||
        (explicitStart && !Number.isNaN(explicitStart.getTime()) ? explicitStart : null);
    let currentTime = 0;
    if (start) {
        currentTime = (Date.now() - start.getTime()) / 1000;
    } else if (Array.isArray(data?.events) && data.events.length) {
        currentTime = Math.max(...data.events.map((event) => Number(event.time) || 0));
    }
    return Math.max(
        0,
        Math.min(duration, currentTime) - getLivePresentationDelaySeconds(),
    );
}

export function computeTeamTotal(teamId, t) {
    return state.gameData.events
        .filter(
        (ev) =>
            ev.time <= t &&
            (ev.delta != null &&
            state.gameData.players[ev.entity] &&
            String(state.gameData.players[ev.entity].team) === String(teamId))
        )
        .reduce((sum, ev) => sum + (ev.delta ?? 0), 0);
}

export function initTeamScores(teams) {
    return Object.fromEntries((teams || []).map(({ id }) => [
        id,
        { score: 0, tagsFor: 0, tagsAgainst: 0 },
    ]));
}

export function computeBaseStats(pid, t) {
    const stats = {};
    state.gameData.events.filter(
        (ev) =>
        ev.entity === pid &&
        ev.time <= t &&
        (ev.type === "base hit" || ev.type === "base destroy")
    ).forEach((ev) => {
        if (!ev.target) return;
        const tgtId = ev.target.toLowerCase();
        if (!stats[tgtId]) {
            stats[tgtId] = { count: 0, destroyCount: 0, destroyed: false };
        }
        stats[tgtId].count++;
        if (ev.type === "base destroy") {
            stats[tgtId].destroyCount++;
            stats[tgtId].destroyed = true;
        }
    });
    return stats;
}


export function computePlayerStats(pid, t) {
    const player = state.gameData.players[pid];
    const sameTeam = (targetId) => {
        const target = state.gameData.players[targetId];
        return target && player && String(target.team) === String(player.team);
    };
    const stats = {
        tagsFor: 0,
        tagsAgainst: 0,
        deniesCount: 0,
        teamKillsFor: 0,
        teamKillsAgainst: 0,
    };
    state.gameData.events
        .filter((ev) => ev.entity === pid && ev.time <= t)
        .forEach((ev) => {
            if (ev.type === "team-kill") {
                stats.teamKillsFor++;
            } else if (ev.type === "team-killed" || ev.type === "team-denied") {
                stats.teamKillsAgainst++;
            } else if (ev.type === "tag") {
                stats[sameTeam(ev.target) ? "teamKillsFor" : "tagsFor"]++;
            } else if (ev.type === "tagged") {
                stats[sameTeam(ev.target) ? "teamKillsAgainst" : "tagsAgainst"]++;
            } else if (ev.type === "deny") {
                stats.deniesCount += ev.delta == 500 ? 2 : 1;
            }
        });

    const ratioText = stats.tagsAgainst > 0
        ? Math.round((stats.tagsFor / stats.tagsAgainst) * 100) + "%"
        : "∞";
    return { ...stats, ratioText };
}

export function computePlayerUptime(pid, t) {
    if (!state.gameData || !state.gameData.events) return 1;
    if (t <= 0) return 1;
    const events = state.gameData.events
        .filter((ev) => ev.entity === pid && (ev.type === "deactivated" || ev.type === "reactivated") && ev.time <= t)
        .sort((a, b) => a.time - b.time);
    let alive = true;
    let lastTime = 0;
    let aliveTime = 0;
    for (const ev of events) {
        if (alive && ev.type === "deactivated") {
            aliveTime += Math.max(0, ev.time - lastTime);
            alive = false;
            lastTime = ev.time;
        } else if (!alive && ev.type === "reactivated") {
            alive = true;
            lastTime = ev.time;
        }
    }
    if (alive) {
        aliveTime += Math.max(0, t - lastTime);
    }
    return aliveTime / t;
}

function normaliseGameType(value) {
    return normaliseText(value).replace(/\s+/g, " ");
}

export function buildPlayerLifeTimeline(pid) {
    const wantedGameType = normaliseGameType(
        state.gameData?.gameType || state.selectedGame?.gameType || state.selectedGame?.title
    );
    const configs = Object.entries(state.reloadReplenishment);
    const exact = configs.find(
        ([gameType]) => normaliseGameType(gameType) === wantedGameType
    );
    const config = exact ? exact[1] : configs.find(
        ([gameType]) => normaliseGameType(gameType) ===
            wantedGameType.replace(/\s*\[test\]$/, "")
    )?.[1];
    const rawLives = wantedGameType ? config?.lives : null;
    if (typeof rawLives !== "number") return null;
    const configuredLives = Number(rawLives);
    if (!Number.isInteger(configuredLives) || configuredLives < 0) return null;

    let lives = configuredLives;
    const timeline = [{ time: 0, lives }];
    for (const event of state.playerEvents[pid] || []) {
        const time = Number(event.time);
        if (!Number.isFinite(time) || time < 0) continue;
        if (event.type === "reload") {
            lives = configuredLives;
        } else if (["tagged", "team-killed", "team-denied"].includes(event.type)) {
            lives = Math.max(0, lives - 1);
        } else {
            continue;
        }
        const previous = timeline[timeline.length - 1];
        if (previous.time === time) {
            previous.lives = lives;
            if (timeline.length > 1 && timeline[timeline.length - 2].lives === lives) {
                timeline.pop();
            }
        } else if (previous.lives !== lives) {
            timeline.push({ time, lives });
        }
    }
    return timeline;
}

export function computePlayerLives(pid, t) {
    const timeline = buildPlayerLifeTimeline(pid);
    if (!timeline) return null;

    let lives = timeline[0].lives;
    for (const point of timeline) {
        if (point.time > t) break;
        lives = point.lives;
    }
    return lives;
}
export function computeHeadToHeadTags(focusPid, otherPid, t) {
    let tagsFor = 0;
    let tagsAgainst = 0;

    state.gameData.events.forEach((ev) => {
        if (ev.time > t || (ev.type !== "tag" && ev.type !== "team-kill")) return;
        if (ev.entity === focusPid && ev.target === otherPid) {
            tagsFor++;
        } else if (ev.entity === otherPid && ev.target === focusPid) {
            tagsAgainst++;
        }
    });

    return { tagsFor, tagsAgainst };
}

export function formatGameDatetime(ts) {
    const m = ts.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return ts;
    const [, YYYY, MM, DD, hh, mm] = m;
    const gameDate = new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:00${GAME_TIMEZONE}`);
    return gameDate.toLocaleDateString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).replace(",", "");
}

export function isTypingField(el) {
    return el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable;
}
