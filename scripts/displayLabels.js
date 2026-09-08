// displayLabels.js
// these are for the display names & team names for games in an event. sorry idk what else to call it

import { normaliseText, parseGameStart } from "./utils.js";
import { summaryPlayerAlias, summaryPlayerAliases } from "./summaryPlayers.js";
import { hasCatalogCoverage, resolveCatalogGame } from "./eventCatalog.js";

function findMatchingEventForGame(game, events = []) {
    if (hasCatalogCoverage(game, events)) return null;
    const gameTypeNorm = normaliseText(game?.title || "");
    if (!gameTypeNorm) return null;
    const gameStart = parseGameStart(game);
    if (!gameStart) return null;

    for (const event of events) {
        const teams = event?.teams;
        if (!teams || typeof teams !== "object") continue;
        const eventGameTypeNorm = normaliseText(event["game-type"]);
        if (!eventGameTypeNorm || eventGameTypeNorm !== gameTypeNorm) continue;
        if (!(event?.ranges || []).some((range) => {
            const start = new Date(range.start);
            const end = new Date(range.end);
            return !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) &&
                gameStart >= start && gameStart <= end;
        })) continue;
        return event;
    }
    return null;
}

export function getMatchedEventTeamNames(game, events = [], fallbackPlayers = []) {
    const managed = resolveCatalogGame(game, events, fallbackPlayers);
    if (managed) return managed.teams.map((team) => team.name);
    const summaryPlayers = summaryPlayerAliases(game?.players);
    const players = summaryPlayers.length > 0
        ? summaryPlayers
        : Array.isArray(fallbackPlayers) ? fallbackPlayers : summaryPlayerAliases(fallbackPlayers);
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
    const managed = resolveCatalogGame(game, events, gamePlayersById);
    if (managed) {
        const actualTeams = Array.isArray(game?.teams)
            ? Object.fromEntries(game.teams.map((team) => [String(team.id), team])) : game?.teams || {};
        return Object.fromEntries(Object.entries(managed.assignments).flatMap(([actualId, teamId]) => {
            const name = managed.teams.find((team) => team.teamId === teamId)?.name;
            return name && actualTeams[actualId]?.color ? [[name, actualTeams[actualId].color]] : [];
        }));
    }
    const event = findMatchingEventForGame(game, events);
    if (!event || !event.teams || typeof event.teams !== "object") return {};

    const playersByTeam = {};
    const directTeams = game?.teams;
    if (directTeams && typeof directTeams === "object" && !Array.isArray(directTeams)) {
        Object.entries(directTeams).forEach(([teamId, teamInfo]) => {
            if (!teamId || !Array.isArray(teamInfo?.players)) return;
            playersByTeam[teamId] = teamInfo.players
                .map((playerId) => normaliseText(summaryPlayerAlias(game?.players, playerId)))
                .filter(Boolean);
        });
    }
    if (!Object.keys(playersByTeam).length) {
        Object.values(gamePlayersById || {}).forEach((player) => {
            if (!player?.team) return;
            (playersByTeam[player.team] ||= []).push(normaliseText(player.name));
        });
    }
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
    const managed = resolveCatalogGame(game, events, fallbackPlayers);
    if (managed) return managed.teams.length
        ? `${managed.label}: ${managed.teams.map((team) => team.name).join(" v ")}` : managed.label;
    const originalTitle = game?.title || "";
    const event = findMatchingEventForGame(game, events);
    const matchedTeams = getMatchedEventTeamNames(game, events, fallbackPlayers);
    if (event && matchedTeams.length > 0) {
        const label = event?.label || event?.name || event?.id || "Event";
        return `${label}: ${matchedTeams.join(" v ")}`;
    }
    return originalTitle;
}

export function getTeamLabelMapForGame(game, gamePlayersById = {}, events = []) {
    const managed = resolveCatalogGame(game, events, gamePlayersById);
    if (managed) return Object.fromEntries(Object.entries(managed.assignments).map(([actualId, teamId]) =>
        [actualId, managed.teams.find((team) => team.teamId === teamId)?.name]));
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
