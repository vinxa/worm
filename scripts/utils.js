import { state } from "./state.js";
import { GAME_TIMEZONE } from "./config.js";

/** Convert hex color "#RRGGBB" to rgba() string with alpha */
export function hexToRGBA(hex, alpha) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

/** Convert an integer number of seconds to "M:SS".
 */
export function formatTime(sec) {
    const total = Math.floor(sec); // drop any fractional part
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + (s < 10 ? "0" + s : s);
}

export function getPlayerHighlightColor(pid) {
    const players = Object.keys(state.gameData.players || {});
    players.sort(); // sort by pid for consistent ordering
    const index = players.indexOf(pid);
    if (index === -1) return "#e2b12a"; // fallback
    const total = players.length;
    const hue = (index / total) * 360;
    return `hsl(${hue}, 70%, 60%)`;
}

export function getGameDuration(data = state.gameData) {
    if (!data) return 0;
    if (data.gameDuration != null) return data.gameDuration;
    const maxEventTime = Math.max(0, ...(data.events || []).map((e) => e.time));
    return maxEventTime;
}


// Helper to compute a team’s total score at time `t`:
export function computeTeamTotal(teamId, t) {
    return state.gameData.events
        .filter(
        (ev) =>
            ev.time <= t &&
            /* event affects this team */ ((ev.teamDelta != null &&
            ev.entity === teamId) ||
            (ev.delta != null && state.gameData.players[ev.entity].team === teamId))
        )
        .reduce((sum, ev) => sum + (ev.teamDelta ?? ev.delta ?? 0), 0);
}

export function computeBaseStats(pid, t) {
    // all base‐related events for this player up to time t
    const evs = state.gameData.events.filter(
        (ev) =>
        ev.entity === pid &&
        ev.time <= t &&
        (ev.type === "base hit" || ev.type === "base destroy")
    );

    const stats = {};
    evs.forEach((ev) => {
        if (!ev.target) return; // skip events with no target
        // normalize the target to lowercase team ID:
        const tgtId = ev.target.toLowerCase(); // "Blue" → "blue"
        if (!stats[tgtId]) stats[tgtId] = { count: 0, destroyed: false };
        stats[tgtId].count++;
        if (ev.type === "base destroy") stats[tgtId].destroyed = true;
    });
    return stats;
}


/**
 * Compute tags, tagged, ratio and base destroys for player `pid` up to time `t`.
 */
export function computePlayerStats(pid, t) {
    // get all events for this player up to time t
    const evs = state.gameData.events.filter((ev) => ev.entity === pid && ev.time <= t);

    // count tags for / against
    let tagsFor = 0,
        tagsAgainst = 0,
        baseCount = 0,
        deniesCount = 0;
    evs.forEach((ev) => {
        if (ev.type === "tag") tagsFor++;
        else if (ev.type === "tagged") tagsAgainst++;
        else if (ev.type === "base destroy") baseCount++;
        else if (ev.type === "deny") {
            if (ev.delta == 500) deniesCount+=2;
            else deniesCount++;
        }    
    });

    // ratio
    const ratioText =
        tagsAgainst > 0 ? Math.round((tagsFor / tagsAgainst) * 100) + "%" : "∞";
    return { tagsFor, tagsAgainst, ratioText, baseCount, deniesCount };
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
/**
 * tags for against between 2 players up to time t
 */
export function computeHeadToHeadTags(focusPid, otherPid, t) {
    let tagsFor = 0;
    let tagsAgainst = 0;

    state.gameData.events.forEach((ev) => {
        if (ev.time > t || ev.type !== "tag") return;
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
    const [,YYYY,MM,DD,hh,mm] = m;    
    // Game timestamps are in GAME_TIMEZONE
    const gameDate = new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:00${GAME_TIMEZONE}`);
    
    // Format in user local timezone
    const options = { 
        weekday: 'short', 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false
    };
    return gameDate.toLocaleDateString(undefined, options).replace(',', '');
}

/**
 * From data.events, build a map of teamId → { sec: totalDeltaAtThatSec, … }
 */
export function bucketTeamDeltas(data) {
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


export function isTypingField(el) {
    return el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.isContentEditable;
}
