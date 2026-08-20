import { state } from "./state.js";
import {
    clearTimeouts,
    detachLivePlayback,
    playReplay,
    seekToTime,
    updatePlayButtonsLabel,
} from "./replayHandler.js";

let syncInterval = null;
let isAdjustingOffset = false;
let lastProgrammaticSeekAt = 0;
let modalSetup = false;
let pendingVideoId = null;
let youtubeReadyPoll = null;
let youtubeReadyPollAttempts = 0;

export function parseYouTubeId(url) {
    return String(url || "").match(/(?:v=|\.be\/)([\w-]{11})/)?.[1] || null;
}

export function getShareableYouTubeUrl(url) {
    const value = String(url || "").trim();
    return parseYouTubeId(value) ? value : "";
}

function isYouTubeApiReady() {
    return typeof window.YT?.Player === "function";
}

export function loadYouTubeUrl(url) {
    const value = getShareableYouTubeUrl(url);
    const urlInput = document.getElementById("youtubeUrl");
    if (urlInput) urlInput.value = value || String(url || "").trim();
    if (!value) return false;
    const videoId = parseYouTubeId(value);
    if (isYouTubeApiReady()) {
        pendingVideoId = null;
        loadVideo(videoId);
        return true;
    }

    pendingVideoId = videoId;
    if (youtubeReadyPoll !== null) return true;
    youtubeReadyPollAttempts = 0;
    youtubeReadyPoll = window.setInterval(() => {
        youtubeReadyPollAttempts += 1;
        if (!isYouTubeApiReady() && youtubeReadyPollAttempts < 400) return;
        window.clearInterval(youtubeReadyPoll);
        youtubeReadyPoll = null;
        youtubeReadyPollAttempts = 0;
        if (!isYouTubeApiReady()) {
            pendingVideoId = null;
            return;
        }
        const readyVideoId = pendingVideoId;
        pendingVideoId = null;
        if (readyVideoId) loadVideo(readyVideoId);
    }, 50);
    return true;
}

function loadVideo(v) {
    if (!v) return;
    if (state.isPlaying) {
        state.isPlaying = false;
        updatePlayButtonsLabel("▶");
        clearTimeouts();
    }
    const offset = parseFloat(document.getElementById("videoOffset").value) || 0;
    const modal = document.getElementById("videoModal");
    modal.style.display = "block";
    modal.style.width = "560px";
    modal.style.height = "355px";
    if (state.player) {
        state.player.loadVideoById(v);
        state.player.seekTo(state.currentTime + offset, true);
    } else {
        state.player = new YT.Player("modalPlayer", {
            height: "315",
            width: "560",
            videoId: v,
            playerVars: { origin: location.origin, disablekb: 1 },
            events: {
                onReady: () => {
                    console.log("YT Player ready");
                    const playerWidth = modal.clientWidth;
                    const playerHeight = modal.clientHeight -
                        modal.querySelector(".modal-header").offsetHeight;
                    const playerElement = document.getElementById("modalPlayer");
                    if (playerElement) {
                        playerElement.style.width = `${playerWidth}px`;
                        playerElement.style.height = `${playerHeight}px`;
                    }
                    if (state.player) {
                        state.player.setSize(playerWidth, playerHeight);
                        if (typeof state.player.setPlaybackRate === "function") {
                            state.player.setPlaybackRate(state.playbackRate);
                        }
                        const originalSeekTo = state.player.seekTo.bind(state.player);
                        state.player.seekTo = function (seconds, allowSeekAhead) {
                            lastProgrammaticSeekAt = Date.now();
                            return originalSeekTo(Math.max(0, seconds), allowSeekAhead);
                        };
                        state.player.seekTo(Math.max(0, state.currentTime + offset), true);
                        syncInterval = setInterval(() => {
                            if (state.player && !isAdjustingOffset) {
                                const recentGameSeek = Date.now() - lastProgrammaticSeekAt < 1000;
                                if (recentGameSeek) return;
                                
                                const currentVideoTime = state.player.getCurrentTime();
                                const offset = parseFloat(document.getElementById("videoOffset").value) || 0;
                                const expectedGameTime = currentVideoTime - offset;
                                if (Math.abs(expectedGameTime - state.currentTime) > 0.5) {
                                    seekToTime(Math.max(0, expectedGameTime), true, {
                                        userInitiated: true,
                                    });
                                }
                            }
                        }, 500);
                    }
                },
                onStateChange: (e) => {
                    if (e.data === YT.PlayerState.PLAYING) {
                        if (!state.isPlaying) {
                            state.isPlaying = true;
                            updatePlayButtonsLabel("❚❚");
                            clearTimeouts();
                            playReplay(
                                state.chart,
                                state.gameData,
                                state.playbackRate,
                                state.replayTimeouts,
                                state.currentTime
                            );
                        }
                    }
                    else if (e.data === YT.PlayerState.PAUSED) {
                        const currentVideoTime = state.player?.getCurrentTime();
                        const offset = parseFloat(document.getElementById("videoOffset").value) || 0;
                        const expectedVideoTime = state.currentTime + offset;
                        const isLikelySeek =
                            currentVideoTime != null &&
                            Math.abs(currentVideoTime - expectedVideoTime) > 0.5;
                        const recentProgrammaticSeek = Date.now() - lastProgrammaticSeekAt < 500;

                        if (isAdjustingOffset || recentProgrammaticSeek || isLikelySeek) return;
                        if (state.isPlaying) {
                            detachLivePlayback();
                            state.isPlaying = false;
                            updatePlayButtonsLabel("▶");
                            clearTimeouts();
                        }
                    }
                },
            },
        });
    }
}

export function setupDraggableModal() {
    if (modalSetup) return;
    modalSetup = true;

    if (!document.querySelector('script[data-youtube-iframe-api="true"]')) {
        const ytTag = document.createElement("script");
        ytTag.src = "https://www.youtube.com/iframe_api";
        ytTag.async = true;
        ytTag.dataset.youtubeIframeApi = "true";
        document.head.appendChild(ytTag);
    }

    const modal = document.getElementById("videoModal");
    const header = modal.querySelector(".modal-header");
    const closeBtn = document.getElementById("modalClose");
    const loadBtn = document.getElementById("loadButton");
    const urlInput = document.getElementById("youtubeUrl");
    const offsetInput = document.getElementById("videoOffset");

    modal.style.display = "none";
    let dragging = false,
        offsetX = 0,
        offsetY = 0;
    let offsetAdjustTimeout;

    loadBtn.addEventListener("click", () => {
        loadYouTubeUrl(urlInput.value);
    });

    offsetInput.addEventListener("input", () => {
        if (!state.player) return;
        isAdjustingOffset = true;
        if (state.isPlaying) {
            detachLivePlayback();
            state.isPlaying = false;
            clearTimeouts();
            updatePlayButtonsLabel("▶");
            if (typeof state.player.pauseVideo === "function") state.player.pauseVideo();
        }
        seekToTime(
            Math.max(0, state.player.getCurrentTime() - (parseFloat(offsetInput.value) || 0)),
            true,
            { userInitiated: true },
        );
        clearTimeout(offsetAdjustTimeout);
        offsetAdjustTimeout = setTimeout(() => {
            isAdjustingOffset = false;
        }, 1000);
    });

    closeBtn.addEventListener("click", () => {
        closeYouTubeModal();
    });

    header.addEventListener("mousedown", (e) => {
        dragging = true;
        const bounds = modal.getBoundingClientRect();
        offsetX = e.clientX - bounds.left;
        offsetY = e.clientY - bounds.top;
        document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        modal.style.left = `${e.clientX - offsetX}px`;
        modal.style.top = `${e.clientY - offsetY}px`;
    });
    window.addEventListener("mouseup", () => {
        dragging = false;
        document.body.style.userSelect = "";
    });

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "modal-resize-handle";
    modal.appendChild(resizeHandle);

    let resizing = false;
    let resizeStartX, resizeStartY, resizeStartWidth, resizeStartHeight;

    resizeHandle.addEventListener("mousedown", (e) => {
        resizing = true;
        resizeStartX = e.clientX;
        resizeStartY = e.clientY;
        resizeStartWidth = modal.offsetWidth;
        resizeStartHeight = modal.offsetHeight;
        document.body.style.userSelect = "none";
        e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
        if (!resizing) return;
        const dx = e.clientX - resizeStartX;
        const dy = e.clientY - resizeStartY;
        const ratio = 16 / 9;
        let newWidth, newHeight;
        if (Math.abs(dx) > Math.abs(dy)) {
            newWidth = resizeStartWidth + dx;
            newHeight = newWidth / ratio;
        } else {
            newHeight = resizeStartHeight + dy;
            newWidth = newHeight * ratio;
        }
        newWidth = Math.max(newWidth, 300);
        newHeight = Math.max(newHeight, 300 / ratio);
        modal.style.width = `${newWidth}px`;
        modal.style.height = `${newHeight}px`;
        const playerElement = document.getElementById("modalPlayer");
        if (playerElement) {
            const playerWidth = modal.clientWidth;
            const playerHeight = modal.clientHeight - header.offsetHeight;
            playerElement.style.width = `${playerWidth}px`;
            playerElement.style.height = `${playerHeight}px`;
            if (state.player) {
                state.player.setSize(playerWidth, playerHeight);
            }
        }
    });

    window.addEventListener("mouseup", () => {
        resizing = false;
        document.body.style.userSelect = "";
    });
}

export function closeYouTubeModal(fullyClose = true) {
    const modal = document.getElementById("videoModal");
    if (modal) modal.style.display = "none";
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
    if (fullyClose && state.player) {
        state.player.destroy();
        state.player = null;
    }
    if (fullyClose) {
        pendingVideoId = null;
        if (youtubeReadyPoll !== null) {
            window.clearInterval(youtubeReadyPoll);
            youtubeReadyPoll = null;
            youtubeReadyPollAttempts = 0;
        }
    }
}

export function toggleYouTubeModal() {
    const modal = document.getElementById("videoModal");
    if (!modal) return;
    if (modal.style.display === "block") {
        closeYouTubeModal(true);
        return;
    }
    const urlInput = document.getElementById("youtubeUrl");
    if (!urlInput?.value.trim()) {
        urlInput?.focus();
        return;
    }
    loadYouTubeUrl(urlInput.value);
}
