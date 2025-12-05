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
    selectedGame: null,
    isGameLoading: false,
    loadingStart: 0,
    gameSignatures: {},
    games: [],
    latestGame: null,
    gameFilter: "all",
    gameDateFilter: "all",
    S3_BASE_URL: "https://worm-game-data.s3.ap-southeast-2.amazonaws.com"
};
