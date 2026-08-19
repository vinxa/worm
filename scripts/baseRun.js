import { normaliseText } from "./utils.js";

const COLOUR_NAME_BY_HEX = {
    "#ff0000": "red",
    "#40ff00": "green",
    "#ffff00": "yellow",
    "#4060ff": "blue",
    "#00ffff": "aqua",
    "#9020ff": "purple",
    "#ffffff": "white",
    "#ff7700": "orange",
    "#ff9000": "orange",
    "#ff10b0": "pink",
    "#000000": "black",
};

export function getGameType(gameData, selectedGame) {
    return gameData?.gameType || selectedGame?.gameType || selectedGame?.title || "";
}

export function isBaseRunGame(gameData, selectedGame) {
    return normaliseText(getGameType(gameData, selectedGame)).includes("base run");
}

export function getCanonicalColourName(subject) {
    const colourFromHex = COLOUR_NAME_BY_HEX[normaliseText(subject?.color)];
    if (colourFromHex) return colourFromHex;
    const colourNames = [subject?.id, subject?.team, subject?.name, subject?.colorName];
    for (const name of colourNames) {
        const simplified = normaliseText(name)
            .replace(/\b(comp|team|base)\b/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (simplified && !/^\d+$/.test(simplified)) return simplified;
    }
    return "";
}

export function getBaseTargetKey(base) {
    const color = normaliseText(base?.color);
    if (color) return `color:${color}`;
    const colourName = getCanonicalColourName(base);
    if (colourName) return `name:${colourName}`;
    return `entity:${normaliseText(base?.entityId)}`;
}

export function getBaseRunLayoutPlan({
    gameData,
    selectedGame,
    currentTime,
    teamIds,
    getTeamTotal,
    policy = null,
}) {
    if (!isBaseRunGame(gameData, selectedGame) || !teamIds.length) return null;
    let groups;
    let baseTargetKeyByTeamId;

    if (policy) {
        const availableTeamIds = new Map(teamIds.map((teamId) => [normaliseText(teamId), teamId]));
        groups = (policy.subgames || [])
            .map((group) => group
                .map((teamId) => availableTeamIds.get(normaliseText(teamId)))
                .filter((teamId) => teamId != null))
            .filter((group) => group.length);
        const groupedTeamIds = new Set(groups.flat().map(normaliseText));
        if (policy.strictTeamSet && teamIds.some((teamId) => !groupedTeamIds.has(normaliseText(teamId)))) {
            return null;
        }
        if (!policy.strictTeamSet) {
            teamIds.forEach((teamId) => {
                if (!groupedTeamIds.has(normaliseText(teamId))) groups.push([teamId]);
            });
        }

        const targetKeyByColourName = new Map();
        (gameData?.active_bases || []).forEach((base) => {
            const colourName = getCanonicalColourName(base);
            if (colourName) targetKeyByColourName.set(colourName, getBaseTargetKey(base));
        });
        baseTargetKeyByTeamId = Object.fromEntries(
            Object.entries(policy.baseTargetByTeamId || {}).map(([teamId, colourName]) => {
                const normalisedColourName = normaliseText(colourName);
                return [
                    normaliseText(teamId),
                    targetKeyByColourName.get(normalisedColourName) || `name:${normalisedColourName}`,
                ];
            })
        );
    } else {
        const availableTeamIds = new Set(teamIds.map(normaliseText));
        const targetKeyById = new Map();
        (gameData?.active_bases || []).forEach((base) => {
            const entityId = normaliseText(base?.entityId);
            if (entityId) targetKeyById.set(entityId, getBaseTargetKey(base));
        });
        (gameData?.teams || []).forEach((team) => {
            const teamId = normaliseText(team?.id);
            if (teamId && !targetKeyById.has(teamId)) {
                targetKeyById.set(teamId, getBaseTargetKey(team));
            }
        });

        const statsByTeam = new Map();
        (gameData?.events || []).forEach((event, eventIndex) => {
            if (Number(event?.time) > currentTime ||
                (event?.type !== "base hit" && event?.type !== "base destroy")) return;
            const teamId = normaliseText(gameData?.players?.[event.entity]?.team);
            const targetId = normaliseText(event.target);
            // Legacy payloads may stringify a missing target as "None".
            if (!teamId || !availableTeamIds.has(teamId) ||
                !targetId || targetId === "none" || targetId === "null") return;
            const targetKey = targetKeyById.get(targetId) || `id:${targetId}`;
            if (!statsByTeam.has(teamId)) statsByTeam.set(teamId, new Map());
            const targetStats = statsByTeam.get(teamId);
            const stats = targetStats.get(targetKey) || { count: 0, firstEventIndex: eventIndex };
            stats.count++;
            targetStats.set(targetKey, stats);
        });

        const targetByTeam = new Map();
        statsByTeam.forEach((targetStats, teamId) => {
            const [winner] = [...targetStats.entries()].sort(([, a], [, b]) =>
                (b.count - a.count) || (a.firstEventIndex - b.firstEventIndex)
            );
            if (winner) targetByTeam.set(teamId, winner[0]);
        });
        if (!targetByTeam.size) return null;

        const originalTeamIds = new Map(teamIds.map((teamId) => [normaliseText(teamId), teamId]));
        const teamsByTarget = new Map();
        targetByTeam.forEach((targetKey, teamId) => {
            if (!teamsByTarget.has(targetKey)) teamsByTarget.set(targetKey, []);
            teamsByTarget.get(targetKey).push(originalTeamIds.get(teamId));
        });
        groups = [...teamsByTarget.values()];
        teamIds.forEach((teamId) => {
            if (!targetByTeam.has(normaliseText(teamId))) groups.push([teamId]);
        });
        baseTargetKeyByTeamId = Object.fromEntries(targetByTeam);
    }
    if (!groups.length) return null;

    const subgames = groups.map((group) => [...group].sort((a, b) =>
        getTeamTotal(b) - getTeamTotal(a)
    ));
    return {
        id: policy?.id || "inferred-base-run",
        subgames,
        baseTargetKeyByTeamId,
    };
}
