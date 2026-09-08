// @ts-check

/**
 * @typedef {{name: string, memberId: string}} Player
 * @typedef {{teamId: string, name: string, players: Player[]}} Team
 * @typedef {{periodId: string, startsAt: string, endsAt: string}} Period
 * @typedef {{gameId: string, gameNumber: number, teamIds: string[], memberIds: string[], isPlaceholder: boolean}} ExampleGame
 * @typedef {{subEventId: string, name: string, type: string, teamIds: string[], periods: Period[], games: ExampleGame[]}} SubEvent
 * @typedef {{
 *   schemaVersion: number,
 *   eventId: string,
 *   name: string,
 *   timezone: string,
 *   useTeams: boolean,
 *   players: Player[],
 *   teams: Team[],
 *   periods: Period[],
 *   subEvents: SubEvent[],
 *   revision?: string,
 *   updatedAt?: string
 * }} EventRecord
 */

export const SUB_EVENT_TYPES = ["Round Robin/Cascade", "Ascension", "Base Run", "Doubles", "Triples", "Solos"];

/** @template T @param {T} value @returns {T} */
const copy = (value) => structuredClone(value);

export const uid = () => crypto.randomUUID();

/** @param {EventRecord} event */
export const playerCount = (event) => event.useTeams
    ? event.teams.reduce((sum, team) => sum + team.players.length, 0)
    : event.players.length;

/** @param {EventRecord} event @returns {EventRecord} */
export function editableEvent(event) {
    const { schemaVersion, eventId, name, timezone, useTeams, players, teams, periods, subEvents } = event;
    const availableTeamIds = teams.map((team) => team.teamId);
    const editableSubEvents = subEvents.map((subEvent) => ({
        ...subEvent,
        teamIds: useTeams
            ? (Array.isArray(subEvent.teamIds) ? subEvent.teamIds : availableTeamIds)
                .filter((teamId) => availableTeamIds.includes(teamId))
            : [],
    }));
    return copy({ schemaVersion, eventId, name, timezone, useTeams, players, teams, periods, subEvents: editableSubEvents });
}

/** @param {EventRecord} event @param {{type: string, teamIds?: string[]}} subEvent @returns {ExampleGame[]} */
export function exampleGames(event, subEvent) {
    const participants = event.useTeams
        ? (Array.isArray(subEvent.teamIds) ? subEvent.teamIds : event.teams.map((team) => team.teamId))
        : event.players.map((player) => player.memberId.trim()).filter(Boolean);
    const unique = [...new Set(participants)];
    if (unique.length < 2) return [];
    for (let index = unique.length - 1; index > 0; index -= 1) {
        const other = Math.floor(Math.random() * (index + 1));
        [unique[index], unique[other]] = [unique[other], unique[index]];
    }
    const count = Math.min(subEvent.type === "Triples" ? 3 : 2, unique.length);
    return Array.from({ length: Math.min(3, unique.length) }, (_, index) => {
        const entrants = Array.from({ length: count }, (__, slot) => unique[(index + slot) % unique.length]);
        return {
            gameId: uid(),
            gameNumber: index + 1,
            teamIds: event.useTeams ? entrants : [],
            memberIds: event.useTeams ? [] : entrants,
            isPlaceholder: true,
        };
    });
}
