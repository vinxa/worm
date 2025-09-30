// video.js
import { state } from "./state.js";
import { playReplay } from "./replay.js";

// Helper to extract YouTube ID
function parseYouTubeId(url) {
    const m = url.match(/(?:v=|\.be\/)([\w\-]{11})/);
    return m ? m[1] : null;
}

// Draggable YouTube modal setup
export function setupDraggableModal() {
    
// Load the YouTube IFrame API
    const ytTag = document.createElement("script");
    ytTag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(ytTag);

    const modal = document.getElementById("videoModal");
    const header = modal.querySelector(".modal-header");
    const closeBtn = document.getElementById("modalClose");
    const loadBtn = document.getElementById("loadButton");
    const urlInput = document.getElementById("youtubeUrl");

    modal.style.display = "none";
    let dragging = false,
        offsetX = 0,
        offsetY = 0;

    loadBtn.addEventListener("click", () => {
        // Pause game replay if running.
        if (state.isPlaying) {
        state.isPlaying = false;
        document.getElementById("playButton").textContent = "▶";
        state.replayTimeouts.forEach((id) => clearTimeout(id));
        state.replayTimeouts = [];
        }
        const v = parseYouTubeId(urlInput.value);
        if (!v) return;
        modal.style.display = "block";
        if (state.player) {
        state.player.loadVideoById(v);
        } else {
        state.player = new YT.Player("modalPlayer", {
            height: "315",
            width: "560",
            videoId: v,
            playerVars: { origin: location.origin, disablekb: 1 },
            events: {
            onReady: () => {
                console.log("YT Player ready");
                if (state.player) state.player.seekTo(state.currentTime, true);
            },
            onStateChange: (e) => {
                // PLAYING → resume game
                if (e.data === YT.PlayerState.PLAYING) {
                if (!state.isPlaying) {
                    state.isPlaying = true;
                    document.getElementById("playButton").textContent = "❚❚";
                    // restart replay from state.currentTime
                    state.replayTimeouts.forEach((id) => clearTimeout(id));
                    state.replayTimeouts = [];
                    playReplay(state.chart, state.gameData, 1, state.replayTimeouts, state.currentTime);
                }
                }
                // PAUSED → pause game
                else if (e.data === YT.PlayerState.PAUSED) {
                if (state.isPlaying) {
                    state.isPlaying = false;
                    document.getElementById("playButton").textContent = "▶";
                    state.replayTimeouts.forEach((id) => clearTimeout(id));
                    state.replayTimeouts = [];
                }
                }
            },
            },
        });
        }
    });

    closeBtn.addEventListener("click", () => {
        modal.style.display = "none";
        state.player.destroy();
        state.player = null;
    });

    header.addEventListener("mousedown", (e) => {
        dragging = true;
        const r = modal.getBoundingClientRect();
        offsetX = e.clientX - r.left;
        offsetY = e.clientY - r.top;
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
}
