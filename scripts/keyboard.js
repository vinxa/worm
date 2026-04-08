import { state } from "./state.js";
import { handleSkip, seekToTime } from "./replayHandler.js";
import { getGameDuration, isTypingField } from "./utils.js";
import { toggleYouTubeModal } from "./video.js";

export function setupKeyboardControls({
    onTogglePlay,
    onJumpToStart,
    onJumpToEnd,
    onSpeedUp,
    onSpeedDown,
    onLatestGame,
    onShowHome,
}) {
    const isGameViewActive = () => {
        const header = document.querySelector("body > .app-header");
        const gameViewActive = header && header.style.display !== "none";
        const videoModal = document.getElementById("videoModal");
        const modalOpen = videoModal && videoModal.style.display === "block";
        return gameViewActive || modalOpen;
    };

    document.addEventListener("keydown", (e) => {
        if (!state.gameData || !isGameViewActive()) return;
        switch (e.code) {
            case "Space":
                e.preventDefault();
                if (state.currentTime >= getGameDuration()) {
                    seekToTime(0);
                }
                onTogglePlay();
                break;
            case "ArrowLeft":
                e.preventDefault();
                if (e.shiftKey) {
                    onJumpToStart();
                    break;
                }
                handleSkip(-15);
                break;
            case "ArrowRight":
                e.preventDefault();
                if (e.shiftKey) {
                    onJumpToEnd();
                    break;
                }
                handleSkip(+15);
                break;
            case "Equal":
            case "NumpadAdd":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                onSpeedUp();
                break;
            case "Minus":
            case "NumpadSubtract":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                onSpeedDown();
                break;
            case "KeyV":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                toggleYouTubeModal();
                break;
            case "KeyL":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                onLatestGame();
                break;
            case "Backspace":
                if (!isTypingField(e.target)) {
                    e.preventDefault();
                    onShowHome();
                }
                break;
        }
    }, true); // Use capture phase to intercept events from iframes
}
