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
let panelSetup = false;
let pendingVideoId = null;
let youtubeReadyPoll = null;
let youtubeReadyPollAttempts = 0;
let videoVisible = false;

const VIDEO_RATIO = 16 / 9;

function announceVideoLayout(change) {
    document.dispatchEvent(new CustomEvent("worm:video-layout-change", { detail: change }));
}

export function fitVideoToPanel() {
    const modal = document.getElementById("videoModal");
    if (!modal || !modal.clientWidth || !modal.clientHeight) return;
    const header = modal.querySelector(".modal-header");
    const availableHeight = Math.max(0, modal.clientHeight - (header?.getBoundingClientRect().height || 0));
    const width = Math.min(modal.clientWidth, availableHeight * VIDEO_RATIO);
    const height = width / VIDEO_RATIO;
    modal.style.setProperty("--video-player-height", `${availableHeight}px`);
    const playerElement = document.getElementById("modalPlayer");
    if (playerElement) {
        playerElement.style.width = `${width}px`;
        playerElement.style.height = `${height}px`;
    }
    state.player?.setSize?.(width, height);
}

function ensureVideoPlaceholder() {
    const modal = document.getElementById("videoModal");
    const body = modal?.querySelector(".modal-body");
    if (!body) return;
    if (!document.getElementById("modalPlayer")) {
        const player = document.createElement("div");
        player.id = "modalPlayer";
        body.prepend(player);
    }
    if (modal.querySelector(".video-placeholder")) return;
    const placeholder = document.createElement("form");
    placeholder.className = "video-placeholder";
    const label = document.createElement("label");
    label.htmlFor = "modalVideoUrl";
    label.textContent = "Load a YouTube video";
    const controls = document.createElement("div");
    controls.className = "video-placeholder-controls";
    const input = document.createElement("input");
    input.id = "modalVideoUrl";
    input.type = "url";
    input.placeholder = "YouTube URL";
    input.setAttribute("aria-label", "YouTube video URL");
    input.value = document.getElementById("youtubeUrl")?.value || "";
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Load";
    controls.append(input, button);
    placeholder.append(label, controls);
    placeholder.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!loadYouTubeUrl(input.value, { show: true })) {
            input.setCustomValidity("Enter a YouTube video URL.");
            input.reportValidity();
        }
    });
    input.addEventListener("input", () => input.setCustomValidity(""));
    body.appendChild(placeholder);
}

export function applyVideoLayout({ visible = videoVisible } = {}) {
    videoVisible = Boolean(visible);
    const modal = document.getElementById("videoModal");
    if (!modal) return;
    ensureVideoPlaceholder();
    modal.classList.add("video-docked");
    modal.style.display = videoVisible ? "block" : "none";
    fitVideoToPanel();
}

function showVideoModal() {
    applyVideoLayout({ visible: true });
    announceVideoLayout({ visible: true });
}

function hideVideoModal() {
    applyVideoLayout({ visible: false });
    announceVideoLayout({ visible: false });
}
let waitingForVideoStart = false;

function getVideoOffset() {
    return parseFloat(document.getElementById("videoOffset")?.value) || 0;
}

export function syncVideoToGame({ seek = false, syncPlayback = false } = {}) {
    const player = state.player;
    if (typeof player?.seekTo !== "function") return false;

    const videoTime = state.currentTime + getVideoOffset();
    const wasWaiting = waitingForVideoStart;
    waitingForVideoStart = videoTime < 0;

    // Negative video times have no footage. Let the game clock advance through
    // that opening instead of mapping the clamped video zero back into the game.
    if (seek || wasWaiting !== waitingForVideoStart) {
        lastProgrammaticSeekAt = Date.now();
        player.seekTo(Math.max(0, videoTime), true);
    }
    if (waitingForVideoStart) {
        if (seek || !wasWaiting || syncPlayback) player.pauseVideo?.();
    } else if (wasWaiting || syncPlayback) {
        if (state.isPlaying) player.playVideo?.();
        else player.pauseVideo?.();
    }
    return waitingForVideoStart;
}

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

export function syncVideoPlaybackRate(actualRate = state.player?.getPlaybackRate?.()) {
    if (typeof state.player?.setPlaybackRate !== "function") return;
    const requestedRate = state.playbackRate;
    const availableRates = state.player.getAvailablePlaybackRates?.();
    // YouTube rounds unsupported rates toward 1x. Choose that native rate
    // explicitly so its rate-change event cannot start a retry loop.
    const videoRate = availableRates?.length
        ? availableRates
            .filter((rate) => rate >= Math.min(1, requestedRate) &&
                rate <= Math.max(1, requestedRate))
            .reduce((closest, rate) =>
                Math.abs(rate - requestedRate) < Math.abs(closest - requestedRate)
                    ? rate : closest, 1)
        : requestedRate;
    if (actualRate !== videoRate) state.player.setPlaybackRate(videoRate);
}

export function loadYouTubeUrl(url, { show = false } = {}) {
    const value = getShareableYouTubeUrl(url);
    const urlInput = document.getElementById("youtubeUrl");
    if (urlInput) urlInput.value = value || String(url || "").trim();
    if (!value) return false;
    if (show) showVideoModal();
    const modalUrlInput = document.getElementById("modalVideoUrl");
    if (modalUrlInput) modalUrlInput.value = value;
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
    const modal = document.getElementById("videoModal");
    ensureVideoPlaceholder();
    modal.classList.add("has-video");
    applyVideoLayout();
    if (state.player) {
        state.player.loadVideoById(v);
        syncVideoPlaybackRate();
        syncVideoToGame({ seek: true });
    } else {
        state.player = new YT.Player("modalPlayer", {
            height: "315",
            width: "560",
            videoId: v,
            playerVars: { origin: location.origin, disablekb: 1 },
            events: {
                onReady: () => {
                    console.log("YT Player ready");
                    fitVideoToPanel();
                    if (state.player) {
                        syncVideoPlaybackRate();
                        syncVideoToGame({ seek: true });
                        syncInterval = setInterval(() => {
                            if (state.player && !isAdjustingOffset) {
                                const waiting = syncVideoToGame();
                                const recentGameSeek = Date.now() - lastProgrammaticSeekAt < 1000;
                                if (recentGameSeek) return;
                                
                                const currentVideoTime = state.player.getCurrentTime();
                                // Zero cannot identify a game time during the
                                // unrecorded opening, but an iframe seek into
                                // actual footage should still move the game.
                                if (waiting && currentVideoTime <= 0.5) return;
                                const expectedGameTime = currentVideoTime - getVideoOffset();
                                if (Math.abs(expectedGameTime - state.currentTime) > 0.5) {
                                    const videoRate = state.player.getPlaybackRate?.();
                                    if (state.isPlaying && videoRate != null &&
                                        videoRate !== state.playbackRate) {
                                        // Keep the worm's clock authoritative while a rate
                                        // change is pending or unavailable (for example 4x).
                                        syncVideoToGame({ seek: true });
                                        return;
                                    }
                                    if (state.isPlaying) clearTimeouts();
                                    seekToTime(Math.max(0, expectedGameTime), true, {
                                        userInitiated: true,
                                    });
                                    syncVideoToGame();
                                    if (state.isPlaying) {
                                        playReplay(
                                            state.chart,
                                            state.gameData,
                                            state.playbackRate,
                                            state.replayTimeouts,
                                            state.currentTime,
                                            { followLiveClock: state.livePlayheadFollowing },
                                        );
                                    }
                                }
                            }
                        }, 500);
                    }
                },
                onPlaybackRateChange: (e) => {
                    syncVideoPlaybackRate(e.data);
                },
                onStateChange: (e) => {
                    if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.CUED) {
                        // Loading/cueing a video resets YouTube to 1x, including
                        // when reusing an existing player without another onReady.
                        syncVideoPlaybackRate();
                    }
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
                        // The iframe's own Play control can fire while its
                        // footage is still ahead of the game playhead.
                        if (state.currentTime + getVideoOffset() < 0) {
                            syncVideoToGame({ syncPlayback: true });
                        }
                    }
                    else if (e.data === YT.PlayerState.PAUSED) {
                        const currentVideoTime = state.player?.getCurrentTime();
                        const expectedVideoTime = Math.max(0, state.currentTime + getVideoOffset());
                        const isLikelySeek =
                            currentVideoTime != null &&
                            Math.abs(currentVideoTime - expectedVideoTime) > 0.5;
                        const recentProgrammaticSeek = Date.now() - lastProgrammaticSeekAt < 500;

                        if (waitingForVideoStart || isAdjustingOffset || recentProgrammaticSeek || isLikelySeek) return;
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

export function setupVideoPanel() {
    if (panelSetup) return;
    panelSetup = true;

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

    modal.setAttribute("role", "region");
    modal.setAttribute("aria-label", "YouTube player");
    offsetInput.setAttribute("aria-label", "Video start offset in seconds");
    applyVideoLayout();
    let offsetAdjustTimeout;

    loadBtn.addEventListener("click", () => {
        loadYouTubeUrl(urlInput.value, { show: true });
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
        if (!document.body.classList.contains("game-view-active") ||
            !document.body.classList.contains("layout-mode")) return;
        hideVideoModal();
    });

    window.addEventListener("resize", fitVideoToPanel);
    window.visualViewport?.addEventListener("resize", fitVideoToPanel);
    if (typeof ResizeObserver === "function") {
        const observer = new ResizeObserver(fitVideoToPanel);
        observer.observe(modal);
        if (header) observer.observe(header);
    }
}

// Compatibility for existing integrations that initialise the video controls.
export const setupDraggableModal = setupVideoPanel;

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
        modal?.classList.remove("has-video");
        ensureVideoPlaceholder();
        waitingForVideoStart = false;
        isAdjustingOffset = false;
        lastProgrammaticSeekAt = 0;
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
        hideVideoModal();
        return;
    }
    showVideoModal();
    if (!state.player) {
        const urlInput = document.getElementById("youtubeUrl");
        if (urlInput?.value.trim()) loadYouTubeUrl(urlInput.value);
        else document.getElementById("modalVideoUrl")?.focus();
    }
}
