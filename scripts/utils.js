import { state } from "./state.js";

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
        else if (ev.type === "deny") deniesCount++;
    });

    // ratio
    const ratioText =
        tagsAgainst > 0 ? Math.round((tagsFor / tagsAgainst) * 100) + "%" : "∞";
    return { tagsFor, tagsAgainst, ratioText, baseCount, deniesCount };
}

export function formatGameDatetime(ts) {
    const m = ts.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return ts;
    const [,YYYY,MM,DD,hh,mm] = m;
    return `${DD}/${MM}/${YYYY}\u00A0${hh}:${mm}`;
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