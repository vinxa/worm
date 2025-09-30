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
    S3_BASE_URL: "https://worm-game-data.s3.ap-southeast-2.amazonaws.com"
};