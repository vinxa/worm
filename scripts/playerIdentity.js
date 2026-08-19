function text(value) {
    return value == null ? "" : String(value);
}

function battlesuitsFor(player) {
    const listed = Array.isArray(player?.battlesuits)
        ? player.battlesuits
        : player?.battlesuits == null || player.battlesuits === ""
            ? []
            : [player.battlesuits];
    const legacy = player?.battlesuit == null || player.battlesuit === ""
        ? []
        : [player.battlesuit];
    return [...new Set([...listed, ...legacy].map(text).filter(Boolean))];
}

/**
 * Canonicalise players and event references on the TDF # entity ID. Older
 * payloads sometimes keyed a player by name or battlesuit while carrying the
 * real ID in the record; entries with that same ID become one player tile.
 */
export function normaliseGamePlayerIdentity(gameData) {
    if (
        !gameData ||
        typeof gameData !== "object" ||
        Array.isArray(gameData) ||
        !Object.prototype.hasOwnProperty.call(gameData, "players")
    ) return gameData;
    const isFullPlayer = (player) => player && typeof player === "object" && [
        "id", "name", "team", "teamId", "battlesuit", "battlesuits", "score",
    ].some((field) => Object.prototype.hasOwnProperty.call(player, field));
    let entries;
    if (Array.isArray(gameData.players)) {
        entries = gameData.players.some(isFullPlayer)
            ? gameData.players
                .map((player, index) => [player?.id ?? index, player])
                .filter(([, player]) => isFullPlayer(player))
            : null;
    } else {
        entries = gameData.players && typeof gameData.players === "object"
            ? Object.entries(gameData.players)
            : [];
        if (entries.length && !entries.some(([, player]) => isFullPlayer(player))) entries = null;
        else entries = entries.filter(([, player]) => isFullPlayer(player));
    }
    // A finalise/index summary uses compact alias/memberId records, not live players.
    if (entries === null) return gameData;

    const players = {};
    const aliases = new Map();
    entries.forEach(([sourceId, source]) => {
        const sourceKey = text(sourceId);
        const embeddedId = text(source?.id);
        const id = [embeddedId, sourceKey].find((candidate) => candidate.startsWith("#")) ||
            embeddedId || sourceKey;
        aliases.set(text(sourceId), id);
        if (source?.id != null) aliases.set(text(source.id), id);

        const existing = players[id] || {};
        const merged = {
            ...existing,
            ...source,
            id,
            team: text(source?.team ?? source?.teamId ?? existing.team),
            battlesuits: [...new Set([
                ...battlesuitsFor(existing),
                ...battlesuitsFor(source),
            ])],
        };
        delete merged.battlesuit;
        players[id] = merged;
    });

    const events = (Array.isArray(gameData.events) ? gameData.events : []).map((event) => {
        if (!event || typeof event !== "object") return event;
        const entity = text(event.entity);
        const target = text(event.target);
        return {
            ...event,
            entity: aliases.get(entity) || event.entity,
            target: aliases.get(target) || event.target,
        };
    });

    return { ...gameData, players, events };
}
