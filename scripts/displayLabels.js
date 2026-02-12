// displayLabels.js

function normaliseText(value) {
    return String(value || "").trim().toLowerCase();
}

function parseGameStart(game) {
    if (!game || !game.id) return null;
    const m = game.id.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    const [, YYYY, MM, DD, hh, mm] = m;
    const parsed = new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isGameInEventRange(game, event) {
    const gameStart = parseGameStart(game);
    if (!gameStart) return false;
    return (event?.ranges || []).some((r) => {
        const start = new Date(r.start);
        const end = new Date(r.end);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
        return gameStart >= start && gameStart <= end;
    });
}

function findMatchingEventForGame(game, events = []) {
    const gameTypeNorm = normaliseText(game?.title || "");
    if (!gameTypeNorm) return null;

    for (const event of events) {
        const teams = event?.teams;
        if (!teams || typeof teams !== "object") continue;
        const eventGameTypeNorm = normaliseText(event["game-type"]);
        if (!eventGameTypeNorm || eventGameTypeNorm !== gameTypeNorm) continue;
        if (!isGameInEventRange(game, event)) continue;
        return event;
    }
    return null;
}

function getEventDisplayLabel(event) {
    return event?.label || event?.name || event?.id || "Event";
}

function getGamePlayerNames(game, fallbackPlayers = []) {
    if (Array.isArray(game?.players) && game.players.length > 0) return game.players;
    return Array.isArray(fallbackPlayers) ? fallbackPlayers : [];
}

function getPlayersByTeam(game, gamePlayersById = {}) {
    const direct = game?.teams;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
        const cleaned = {};
        Object.entries(direct).forEach(([teamId, teamInfo]) => {
            const members = teamInfo?.players;
            if (!teamId || !Array.isArray(members)) return;
            cleaned[teamId] = members
                .map((name) => normaliseText(name))
                .filter(Boolean);
        });
        if (Object.keys(cleaned).length) return cleaned;
    }

    const built = {};
    Object.values(gamePlayersById || {}).forEach((p) => {
        if (!p || !p.team) return;
        if (!built[p.team]) built[p.team] = [];
        built[p.team].push(normaliseText(p.name));
    });
    return built;
}

export function getMatchedEventTeamNames(game, events = [], fallbackPlayers = []) {
    const players = getGamePlayerNames(game, fallbackPlayers);
    if (!players.length) return [];

    const event = findMatchingEventForGame(game, events);
    if (!event) return [];

    const gamePlayersSet = new Set(players.map((name) => normaliseText(name)).filter(Boolean));
    const matchedTeams = [];
    Object.entries(event.teams).forEach(([teamName, members], idx) => {
        if (!teamName || !Array.isArray(members)) return;
        const matchedCount = members.reduce(
            (sum, member) => sum + (gamePlayersSet.has(normaliseText(member)) ? 1 : 0),
            0
        );
        if (matchedCount > 0) {
            matchedTeams.push({ teamName, matchedCount, idx });
        }
    });
    return matchedTeams
        .sort((a, b) => (b.matchedCount - a.matchedCount) || (a.idx - b.idx))
        .slice(0, 3)
        .map((t) => t.teamName);
}

export function getEventTeamColourMap(game, events = [], gamePlayersById = {}) {
    const event = findMatchingEventForGame(game, events);
    if (!event || !event.teams || typeof event.teams !== "object") return {};

    const playersByTeam = getPlayersByTeam(game, gamePlayersById);
    const teamInfo = game?.teams && typeof game.teams === "object" ? game.teams : {};
    if (!Object.keys(playersByTeam).length || !Object.keys(teamInfo).length) return {};

    const result = {};
    Object.entries(event.teams).forEach(([eventTeamName, members]) => {
        if (!eventTeamName || !Array.isArray(members)) return;
        const eventMemberSet = new Set(members.map((name) => normaliseText(name)).filter(Boolean));
        let bestTeamId = "";
        let bestScore = 0;

        Object.entries(playersByTeam).forEach(([teamId, teamMembers]) => {
            const score = teamMembers.reduce(
                (sum, name) => sum + (eventMemberSet.has(name) ? 1 : 0),
                0
            );
            if (score > bestScore) {
                bestScore = score;
                bestTeamId = teamId;
            }
        });

        const color = teamInfo?.[bestTeamId]?.color;
        if (bestTeamId && bestScore > 0 && color) {
            result[eventTeamName] = color;
        }
    });

    return result;
}

export function getGameDisplayTitle(game, events = [], fallbackPlayers = []) {
    const originalTitle = game?.title || "";
    const event = findMatchingEventForGame(game, events);
    const matchedTeams = getMatchedEventTeamNames(game, events, fallbackPlayers);
    if (event && matchedTeams.length > 0) {
        return `${getEventDisplayLabel(event)}: ${matchedTeams.join(" v ")}`;
    }
    return originalTitle;
}

export function getTeamLabelMapForGame(game, gamePlayersById = {}, events = []) {
    const event = findMatchingEventForGame(game, events);
    if (!event) return {};

    const eventTeams = Object.entries(event.teams || {}).map(([teamName, members]) => ({
        teamName,
        membersSet: new Set((Array.isArray(members) ? members : []).map((name) => normaliseText(name))),
    }));
    if (!eventTeams.length) return {};

    const gamePlayersByTeam = {};
    Object.values(gamePlayersById).forEach((p) => {
        if (!p || !p.team) return;
        if (!gamePlayersByTeam[p.team]) gamePlayersByTeam[p.team] = [];
        gamePlayersByTeam[p.team].push(normaliseText(p.name));
    });

    const assignments = {};
    const remainingEventTeams = [...eventTeams];
    Object.entries(gamePlayersByTeam).forEach(([teamId, members]) => {
        let bestIdx = -1;
        let bestScore = 0;
        remainingEventTeams.forEach((evt, idx) => {
            const score = members.reduce((sum, name) => sum + (evt.membersSet.has(name) ? 1 : 0), 0);
            if (score > bestScore) {
                bestScore = score;
                bestIdx = idx;
            }
        });
        if (bestIdx >= 0 && bestScore > 0) {
            assignments[teamId] = remainingEventTeams[bestIdx].teamName;
            remainingEventTeams.splice(bestIdx, 1);
        }
    });

    return assignments;
}
