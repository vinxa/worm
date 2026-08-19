import { getCanonicalColourName, getGameType } from "../baseRun.js";
import { normaliseText, parseGameStart } from "../utils.js";

const EVENT_NAME = "clash 3";
const GAME_TYPE = "base run 6deac 1sps no stuns";
const SUBGAMES = [
    { teams: ["red", "green"], base: "blue" },
    { teams: ["orange", "blue"], base: "green" },
    { teams: ["pink", "yellow"], base: "red" },
];

export function getClash3BaseRunPolicy({ gameData, selectedGame, events }) {
    if (normaliseText(getGameType(gameData, selectedGame)) !== GAME_TYPE) return null;
    const gameStart = parseGameStart(selectedGame || gameData);
    const isClash3Game = gameStart && (events || []).some((event) =>
        normaliseText(event?.name || event?.label || event?.id) === EVENT_NAME &&
        (event?.ranges || []).some((range) => {
            const start = new Date(range?.start);
            const end = new Date(range?.end);
            return !Number.isNaN(start.getTime()) &&
                !Number.isNaN(end.getTime()) &&
                gameStart >= start && gameStart <= end;
        })
    );
    if (!isClash3Game) return null;

    const teamIdByColour = {};
    (gameData?.teams || []).forEach((team) => {
        const colour = getCanonicalColourName(team);
        if (colour && !teamIdByColour[colour]) teamIdByColour[colour] = team.id;
    });

    const subgames = SUBGAMES
        .map(({ teams }) => teams.map((colour) => teamIdByColour[colour]).filter((id) => id != null))
        .filter((group) => group.length);
    const baseTargetByTeamId = {};
    SUBGAMES.forEach(({ teams, base }) => {
        teams.forEach((colour) => {
            const teamId = teamIdByColour[colour];
            if (teamId != null) baseTargetByTeamId[normaliseText(teamId)] = base;
        });
    });

    return {
        id: "clash-3-base-run",
        subgames,
        baseTargetByTeamId,
        strictTeamSet: true,
    };
}
