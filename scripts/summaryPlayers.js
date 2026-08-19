export function summaryPlayerRecordMap(players) {
    if (!players || Array.isArray(players) || typeof players !== "object") return {};
    return Object.fromEntries(
        Object.entries(players).map(([playerId, player]) => [
            String(playerId),
            {
                alias: typeof player === "string"
                    ? player
                    : String(player?.alias ?? player?.name ?? playerId),
                ...(typeof player === "object" && player?.memberId
                    ? { memberId: String(player.memberId) }
                    : {}),
            },
        ])
    );
}

export function summaryPlayerAliasMap(players) {
    return Object.fromEntries(
        Object.entries(summaryPlayerRecordMap(players)).map(([playerId, player]) => [
            playerId,
            player.alias,
        ])
    );
}

export function summaryPlayerAliases(players) {
    if (Array.isArray(players)) {
        return players
            .map((player) => typeof player === "string" ? player : player?.name ?? player?.alias)
            .filter(Boolean);
    }
    return Object.values(summaryPlayerAliasMap(players)).filter(Boolean);
}

export function summaryPlayerAlias(players, playerId) {
    const aliases = summaryPlayerAliasMap(players);
    return aliases[String(playerId)] ?? String(playerId ?? "");
}

export function latestSummaryPlayerRecords(games = []) {
    const latest = {};
    [...games]
        .sort((left, right) => String(right?.id ?? "").localeCompare(String(left?.id ?? "")))
        .forEach((game) => {
            Object.entries(summaryPlayerRecordMap(game?.players)).forEach(([playerId, player]) => {
                if (!Object.prototype.hasOwnProperty.call(latest, playerId)) {
                    latest[playerId] = player;
                }
            });
        });
    return latest;
}
