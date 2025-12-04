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
    S3_BASE_URL: "https://worm-game-data.s3.ap-southeast-2.amazonaws.com",
    liveWS: null,             // current WebSocket connection for live
    liveGameMeta: null,       // last metadata packet from the live stream
    liveGameEvents: [],       // live events received for the current live game
    liveGameHasEnded: false,
    watchCurrentLive: false,
    watchIntervalId: null,
    liveReplayRequested: false, // whether we've asked the server to replay cached state
    liveReconnectTimeoutId: null, // timer id for WS reconnect

};
