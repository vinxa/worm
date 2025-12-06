// state.js
export const state = {
    gameData: null,
    playerEvents: {},
    chart: null,
    player: null,
    isPlaying: false,
    replayTimeouts: [],
    currentTime: 0,
    teamScores: {},
    teamFullTimeline: {},
    playerTimelines: {},
    selectedPlayers: new Set(),
    hiddenTeams: null, // null = all teams visible; otherwise Set of hidden team IDs
    selectedGame: null,
    playbackRate: 1,
    isGameLoading: false,
    loadingStart: 0,
    gameSignatures: {},
    games: [],
    latestGame: null,
    gameFilter: "all",
    gameDateFilter: "all",
    gamePlayerFilter: "all",
    gamePlayerFilterText: "",
    S3_BASE_URL: "https://worm-game-data.s3.ap-southeast-2.amazonaws.com"
};
