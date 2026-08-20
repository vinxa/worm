const GAME_QUERY_PARAM = "game";
const TIME_QUERY_PARAM = "t";
const SPEED_QUERY_PARAM = "speed";
const YOUTUBE_QUERY_PARAM = "youtube";
const PLAYER_QUERY_PARAM = "player";
const TEAM_QUERY_PARAM = "team";
const SPLIT_WORM_QUERY_PARAM = "split";
const COMPARISON_DETAILS_QUERY_PARAM = "details";
const PLAYBACK_RATES = new Set([0.5, 1, 1.5, 2, 4]);
const VIEW_QUERY_PARAMS = [
    TIME_QUERY_PARAM,
    SPEED_QUERY_PARAM,
    YOUTUBE_QUERY_PARAM,
    PLAYER_QUERY_PARAM,
    TEAM_QUERY_PARAM,
    SPLIT_WORM_QUERY_PARAM,
    COMPARISON_DETAILS_QUERY_PARAM,
];

function currentUrl() {
    return new URL(window.location.href);
}

export function getGameIdFromUrl() {
    return currentUrl().searchParams.get(GAME_QUERY_PARAM)?.trim() || "";
}

function parseNonNegativeNumber(value) {
    if (value === null || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

function uniqueValues(values) {
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function clearViewQueryParams(url) {
    VIEW_QUERY_PARAMS.forEach((param) => url.searchParams.delete(param));
    return url;
}

export function getViewStateFromUrl() {
    const params = currentUrl().searchParams;
    const playbackRate = parseNonNegativeNumber(params.get(SPEED_QUERY_PARAM));
    const comparisonDetails = params.get(COMPARISON_DETAILS_QUERY_PARAM)?.toLowerCase();
    return {
        time: parseNonNegativeNumber(params.get(TIME_QUERY_PARAM)),
        playbackRate: PLAYBACK_RATES.has(playbackRate) ? playbackRate : null,
        youtubeUrl: params.get(YOUTUBE_QUERY_PARAM)?.trim() || "",
        selectedPlayers: uniqueValues(params.getAll(PLAYER_QUERY_PARAM)),
        selectedTeams: uniqueValues(params.getAll(TEAM_QUERY_PARAM)),
        splitWorm: ["1", "true"].includes(params.get(SPLIT_WORM_QUERY_PARAM)?.toLowerCase()),
        comparisonDetails: !["0", "false"].includes(comparisonDetails),
    };
}

export function getShareHref({
    time,
    playbackRate,
    youtubeUrl = "",
    selectedPlayers = [],
    selectedTeams = [],
    splitWorm = false,
    comparisonDetails = true,
} = {}) {
    const url = clearViewQueryParams(currentUrl());
    const parsedTime = parseNonNegativeNumber(time);
    const parsedRate = parseNonNegativeNumber(playbackRate);

    if (parsedTime !== null) url.searchParams.set(TIME_QUERY_PARAM, String(parsedTime));
    if (PLAYBACK_RATES.has(parsedRate)) {
        url.searchParams.set(SPEED_QUERY_PARAM, String(parsedRate));
    }
    if (youtubeUrl.trim()) url.searchParams.set(YOUTUBE_QUERY_PARAM, youtubeUrl.trim());
    uniqueValues([...selectedPlayers]).forEach((playerId) =>
        url.searchParams.append(PLAYER_QUERY_PARAM, playerId)
    );
    uniqueValues([...selectedTeams]).forEach((teamId) =>
        url.searchParams.append(TEAM_QUERY_PARAM, teamId)
    );
    if (splitWorm) url.searchParams.set(SPLIT_WORM_QUERY_PARAM, "1");
    if (!comparisonDetails) url.searchParams.set(COMPARISON_DETAILS_QUERY_PARAM, "0");
    return url.toString();
}

export function getGameHref(game) {
    const url = clearViewQueryParams(currentUrl());
    url.searchParams.set(GAME_QUERY_PARAM, String(game?.id || ""));
    return url.toString();
}

export function setGameUrl(game, { replace = false } = {}) {
    const gameId = String(game?.id || "");
    if (!gameId || getGameIdFromUrl() === gameId) return;

    const method = replace ? "replaceState" : "pushState";
    window.history[method]({ gameId }, "", getGameHref(game));
}

export function clearGameUrl({ replace = false } = {}) {
    const url = currentUrl();
    const hasGameState = url.searchParams.has(GAME_QUERY_PARAM) ||
        VIEW_QUERY_PARAMS.some((param) => url.searchParams.has(param));
    if (!hasGameState) return;

    url.searchParams.delete(GAME_QUERY_PARAM);
    clearViewQueryParams(url);
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", url.toString());
}
