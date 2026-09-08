import { parseGameStart } from "./utils.js";

const TYPES = new Set(["Round Robin/Cascade", "Ascension", "Base Run", "Doubles", "Triples", "Solos"]);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const time = (value) => text(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const validId = (value) => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value);
const revision = (value) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

/** Public responses are validated before they can replace the last good catalog. */
export function validateEventCatalog(response) {
    const invalid = () => { throw new Error("Invalid event catalog response"); };
    if (!object(response) || response.ok !== true || !Array.isArray(response.events) || response.events.length > 1000) invalid();
    const eventIds = new Set();
    response.events.forEach((event) => {
        if (!object(event) || event.schemaVersion !== 1 || !validId(event.eventId) ||
            eventIds.has(event.eventId) || !text(event.name) || !text(event.timezone) ||
            !revision(event.revision) || !time(event.updatedAt) || typeof event.useTeams !== "boolean" ||
            !Array.isArray(event.teams) || !Array.isArray(event.players) ||
            !Array.isArray(event.subEvents) || !Array.isArray(event.periods)) invalid();
        try { new Intl.DateTimeFormat("en", { timeZone: event.timezone }); } catch { invalid(); }
        eventIds.add(event.eventId);
        const ids = new Set([event.eventId]);
        const identity = (id) => {
            if (!validId(id) || ids.has(id)) invalid();
            ids.add(id);
        };
        const members = new Set();
        const players = (rows) => {
            if (!Array.isArray(rows)) invalid();
            rows.forEach((player) => {
                if (!object(player) || !text(player.name) || !text(player.memberId) || members.has(player.memberId)) invalid();
                members.add(player.memberId);
            });
        };
        const periods = (rows) => {
            if (!Array.isArray(rows)) invalid();
            rows.forEach((period) => {
                if (!object(period) || !time(period.startsAt) || !time(period.endsAt) ||
                    Date.parse(period.startsAt) >= Date.parse(period.endsAt)) invalid();
                identity(period.periodId);
            });
        };
        players(event.players);
        event.teams.forEach((team) => {
            if (!object(team) || !text(team.name)) invalid();
            identity(team.teamId);
            players(team.players);
        });
        const teamIds = new Set(event.teams.map((team) => team.teamId));
        if ((event.useTeams && event.players.length) || (!event.useTeams && event.teams.length) ||
            (event.subEvents.length && event.periods.length)) invalid();
        periods(event.periods);
        event.subEvents.forEach((subEvent) => {
            if (!object(subEvent) || !text(subEvent.name) || !TYPES.has(subEvent.type) || !Array.isArray(subEvent.games)) invalid();
            identity(subEvent.subEventId);
            periods(subEvent.periods);
            const allocatedTeamIds = subEvent.teamIds === undefined
                ? new Set(teamIds)
                : Array.isArray(subEvent.teamIds) ? new Set(subEvent.teamIds) : invalid();
            if (allocatedTeamIds.size !== (subEvent.teamIds?.length ?? allocatedTeamIds.size) ||
                [...allocatedTeamIds].some((id) => !teamIds.has(id)) || (!event.useTeams && allocatedTeamIds.size)) invalid();
            const numbers = new Set();
            subEvent.games.forEach((game) => {
                // Sample pairings describe the unfinished editor, never actual fixtures.
                if (!object(game) || game.isPlaceholder !== true || !Number.isSafeInteger(game.gameNumber) ||
                    game.gameNumber < 1 || numbers.has(game.gameNumber) ||
                    !Array.isArray(game.teamIds) || !Array.isArray(game.memberIds) ||
                    new Set(game.teamIds).size !== game.teamIds.length ||
                    new Set(game.memberIds).size !== game.memberIds.length ||
                    game.teamIds.some((id) => !allocatedTeamIds.has(id)) || game.memberIds.some((id) => !members.has(id)) ||
                    (event.useTeams ? game.memberIds.length : game.teamIds.length)) invalid();
                identity(game.gameId);
                numbers.add(game.gameNumber);
            });
        });
    });
    return response.events;
}

export function eventPeriods(event) {
    return event.subEvents.length ? event.subEvents.flatMap((subEvent) => subEvent.periods) : event.periods;
}

export function catalogEventOptions(records, legacyEvents = []) {
    const options = records.flatMap((event) => {
        const option = (subEvent = null) => ({
            id: `admin:${event.eventId}${subEvent ? ":" + subEvent.subEventId : ""}`,
            name: subEvent ? `${event.name} · ${subEvent.name}` : event.name,
            ranges: (subEvent ? subEvent.periods : eventPeriods(event))
                .map((period) => ({ start: period.startsAt, end: period.endsAt })),
            managedEvent: event,
            managedSubEventId: subEvent?.subEventId || null,
        });
        return [option(), ...event.subEvents.map(option)];
    });
    return [...options, ...legacyEvents];
}

export function createEventCatalogLoader({ url, fetcher = (...args) => fetch(...args), onChange = () => {}, onError = () => {} }) {
    let current = [];
    let signature = "";
    let request = null;
    return {
        get current() { return current; },
        refresh() {
            if (!url) return Promise.resolve(current);
            if (request) return request;
            request = (async () => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);
                try {
                    const response = await fetcher(`${url.replace(/\/$/, "")}/events`, {
                        cache: "no-store", signal: controller.signal,
                    });
                    if (!response.ok) throw new Error(`Event catalog HTTP ${response.status}`);
                    const records = validateEventCatalog(await response.json());
                    const nextSignature = JSON.stringify(records.map((event) => [event.eventId, event.revision]));
                    current = records;
                    if (signature !== nextSignature) {
                        signature = nextSignature;
                        onChange(records);
                    }
                } catch (error) {
                    onError(error);
                } finally {
                    clearTimeout(timeout);
                }
                return current;
            })().finally(() => { request = null; });
            return request;
        },
    };
}

function gameIdentities(game, fallback) {
    const players = new Map();
    for (const source of [game?.players, fallback]) {
        if (!object(source)) continue;
        Object.entries(source).forEach(([id, player]) => {
            if (!object(player)) return;
            players.set(id, { ...players.get(id), ...player });
        });
    }
    const groups = new Map();
    const actualTeams = Array.isArray(game?.teams)
        ? game.teams.map((team) => [String(team.id), team]) : Object.entries(game?.teams || {});
    actualTeams.forEach(([id, team]) => {
        if (Array.isArray(team?.players)) groups.set(id, team.players.map((id) => players.get(String(id))).filter(Boolean));
    });
    players.forEach((player) => {
        if (player.team == null) return;
        const id = String(player.team);
        if (!groups.has(id)) groups.set(id, []);
        if (!groups.get(id).includes(player)) groups.get(id).push(player);
    });
    return { players: [...players.values()], groups };
}

function active(periods, instant) {
    return periods.some((period) => instant >= Date.parse(period.startsAt) && instant < Date.parse(period.endsAt));
}

function startTime(game) {
    return parseGameStart(game)?.getTime() ?? Date.parse(game?.startTime);
}

/** Prevent old alias-based definitions from overriding managed event coverage. */
export function hasCatalogCoverage(game, options = []) {
    const instant = startTime(game);
    return options.some((option) => option.managedEvent && active(eventPeriods(option.managedEvent), instant));
}

export function resolveCatalogGame(game, options = [], fallbackPlayers = {}) {
    const instant = startTime(game);
    if (!Number.isFinite(instant)) return null;
    const identity = gameIdentities(game, fallbackPlayers);
    const members = new Set(identity.players.map((player) => player.memberId == null ? "" : String(player.memberId)).filter(Boolean));
    const records = [...new Map(options.filter((option) => option.managedEvent)
        .map((option) => [option.managedEvent.eventId, option.managedEvent])).values()];
    const candidates = records.filter((event) => active(eventPeriods(event), instant)).map((event) => {
        const activeSubEvents = event.subEvents.filter((subEvent) => active(subEvent.periods, instant));
        const subEvent = activeSubEvents.length === 1 ? activeSubEvents[0] : null;
        const allocatedTeamIds = subEvent && Array.isArray(subEvent.teamIds) ? new Set(subEvent.teamIds) : null;
        const configuredTeams = allocatedTeamIds
            ? event.teams.filter((team) => allocatedTeamIds.has(team.teamId))
            : event.teams;
        const roster = event.useTeams ? configuredTeams.flatMap((team) => team.players) : event.players;
        const evidence = roster.filter((player) => members.has(player.memberId)).length;
        if (roster.length && !evidence) return null;
        const assignments = {};
        identity.groups.forEach((players, actualId) => {
            const teamMembers = new Set(players.map((player) => player.memberId == null ? "" : String(player.memberId)));
            const scores = configuredTeams.map((team) => ({ team, score: team.players.filter((player) => teamMembers.has(player.memberId)).length }));
            const best = Math.max(0, ...scores.map(({ score }) => score));
            const winners = scores.filter(({ score }) => score > 0 && score === best);
            if (winners.length === 1) assignments[actualId] = winners[0].team.teamId;
        });
        const counts = Object.values(assignments);
        Object.keys(assignments).forEach((id) => {
            if (counts.filter((value) => value === assignments[id]).length > 1) delete assignments[id];
        });
        const teams = identity.groups.size
            ? configuredTeams.filter((team) => Object.values(assignments).includes(team.teamId))
            : configuredTeams.filter((team) => team.players.some((player) => members.has(player.memberId)));
        return { event, subEvent, teams, assignments, evidence,
            label: `${event.name}${subEvent ? " · " + subEvent.name : ""}` };
    }).filter(Boolean);
    // Membership evidence can distinguish an event from an overlapping empty draft.
    const supported = candidates.filter((candidate) => candidate.evidence > 0);
    const eligible = supported.length ? supported : candidates;
    return eligible.length === 1 ? eligible[0] : null;
}

export function matchesCatalogEvent(game, option, options) {
    const result = resolveCatalogGame(game, options);
    return Boolean(result && result.event.eventId === option.managedEvent.eventId &&
        (!option.managedSubEventId || option.managedSubEventId === result.subEvent?.subEventId));
}
