// video.js
import { state } from "./state.js";
import { playReplay } from "./replayHandler.js";

// Helper to extract YouTube ID
function parseYouTubeId(url) {
    const m = url.match(/(?:v=|\.be\/)([\w\-]{11})/);
    return m ? m[1] : null;
}

// Load video by ID, pausing game if playing
function loadVideo(v) {
    if (!v) return;
    // Pause game replay if running.
    if (state.isPlaying) {
        state.isPlaying = false;
        document.getElementById("playButton").textContent = "▶";
        state.replayTimeouts.forEach((id) => clearTimeout(id));
        state.replayTimeouts = [];
    }
    const modal = document.getElementById("videoModal");
    modal.style.display = "block";
    modal.style.width = "560px";
    modal.style.height = "355px"; // 315 + 40 for header
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
                    // Resize player to fit modal
                    const modal = document.getElementById("videoModal");
                    const header = modal.querySelector('.modal-header');
                    const headerHeight = header ? header.offsetHeight : 40;
                    const playerWidth = modal.clientWidth;
                    const playerHeight = modal.clientHeight - headerHeight;
                    const playerElement = document.getElementById("modalPlayer");
                    if (playerElement) {
                        playerElement.style.width = `${playerWidth}px`;
                        playerElement.style.height = `${playerHeight}px`;
                    }
                    if (state.player) state.player.setSize(playerWidth, playerHeight);
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
                            document.getElementById("playButton").textContent = "❚❚";
                            state.replayTimeouts.forEach((id) => clearTimeout(id));
                            state.replayTimeouts = [];
                        }
                    }
                },
            },
        });
    }
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
        const v = parseYouTubeId(urlInput.value);
        loadVideo(v);
    });

    closeBtn.addEventListener("click", () => {
        closeYouTubeModal();
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

    // Add resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'modal-resize-handle';
    modal.appendChild(resizeHandle);

    let resizing = false;
    let resizeStartX, resizeStartY, resizeStartWidth, resizeStartHeight;

    resizeHandle.addEventListener('mousedown', (e) => {
        resizing = true;
        resizeStartX = e.clientX;
        resizeStartY = e.clientY;
        resizeStartWidth = modal.offsetWidth;
        resizeStartHeight = modal.offsetHeight;
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        const dx = e.clientX - resizeStartX;
        const dy = e.clientY - resizeStartY;
        //const ratio = resizeStartWidth / resizeStartHeight;
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
        const playerElement = document.getElementById('modalPlayer');
        if (playerElement) {
            const header = modal.querySelector('.modal-header');
            const headerHeight = header ? header.offsetHeight : 40;
            const playerWidth = modal.clientWidth;
            const playerHeight = modal.clientHeight - headerHeight;
            playerElement.style.width = `${playerWidth}px`;
            playerElement.style.height = `${playerHeight}px`;
            if (state.player) {
                state.player.setSize(playerWidth, playerHeight);
            }
        }
    });

    window.addEventListener('mouseup', () => {
        resizing = false;
        document.body.style.userSelect = '';
    });
}

export function closeYouTubeModal(fullyClose = true) {
    const modal = document.getElementById("videoModal");
    if (modal) {
        modal.style.display = "none";
    }
    if (state.player && fullyClose) {
        state.player.destroy();
        state.player = null;
    }
}

export function toggleYouTubeModal() {
    const modal = document.getElementById("videoModal");
    if (!modal) return;
    const isOpen = modal.style.display === "block";
    if (isOpen) {
        closeYouTubeModal(true);
        return;
    }
    // Opening
    const urlInput = document.getElementById("youtubeUrl");
    const v = parseYouTubeId(urlInput.value);
    if (v) {
        loadVideo(v);
    } else {
        modal.style.display = "block";
    }
}
