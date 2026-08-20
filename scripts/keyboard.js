import { state } from "./state.js";
import { handleSkip, seekToTime } from "./replayHandler.js";
import { getGameDuration, isTypingField } from "./utils.js";
import { toggleYouTubeModal } from "./video.js";

export function setupKeyboardShortcutsModal() {
    const modal = document.getElementById("keyboardShortcutsModal");
    const openButton = document.getElementById("keyboardShortcutsButton");
    const closeButton = document.getElementById("keyboardShortcutsClose");
    if (!modal || !openButton || !closeButton) return;

    const closeModal = () => {
        if (!modal.open || modal.classList.contains("is-closing")) return;
        modal.classList.add("is-closing");
    };

    openButton.addEventListener("click", () => {
        modal.classList.remove("is-closing");
        modal.showModal();
    });
    closeButton.addEventListener("click", closeModal);

    modal.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeModal();
    });

    modal.addEventListener("animationend", (event) => {
        if (event.target !== modal || !modal.classList.contains("is-closing")) return;
        modal.close();
        modal.classList.remove("is-closing");
    });

    modal.addEventListener("click", (event) => {
        const bounds = modal.getBoundingClientRect();
        const clickedBackdrop =
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom;
        if (clickedBackdrop) closeModal();
    });
}

export function setupKeyboardControls({
    onTogglePlay,
    onJumpToStart,
    onJumpToEnd,
    onPreviousGame,
    onNextGame,
    onSpeedUp,
    onSpeedDown,
    onLatestGame,
    onToggleFollowLive,
    onClearFilters,
    onClearSelections,
    onWiggleWorm,
    onShareGame,
    onToggleComparisonDetails,
    onToggleSplitTimelines,
    onShowHome,
}) {
    document.addEventListener("keydown", (e) => {
        if (document.querySelector("dialog[open]")) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTypingField(e.target) && e.code !== "Escape") return;

        const gameHeader = document.querySelector("body > .app-header");
        const videoModal = document.getElementById("videoModal");
        const gameViewActive = Boolean(gameHeader && gameHeader.style.display !== "none");
        const videoModalOpen = Boolean(videoModal && videoModal.style.display === "block");
        if (!gameViewActive && !videoModalOpen) {
            switch (e.code) {
                case "KeyW":
                    e.preventDefault();
                    onWiggleWorm();
                    break;
                case "Escape":
                    e.preventDefault();
                    onClearFilters();
                    break;
                case "KeyL":
                    e.preventDefault();
                    if (e.shiftKey) {
                        onToggleFollowLive();
                    } else {
                        onLatestGame();
                    }
                    break;
                }
            return;
        }

        if (!state.gameData) return;
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
            case "Comma":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                onPreviousGame();
                break;
            case "Period":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                onNextGame();
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
                if (e.shiftKey) {
                    onToggleFollowLive();
                } else {
                    onLatestGame();
                }
                break;
            case "Escape":
                e.preventDefault();
                if (state.selectedPlayers?.size || state.hiddenTeams?.size) {
                    onClearSelections();
                } else {
                    onShowHome();
                }
                break;
            case "KeyW":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                onWiggleWorm();
                break;
            case "KeyC":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                onShareGame();
                break;
            case "KeyD":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                onToggleComparisonDetails();
                break;
            case "KeyS":
                if (isTypingField(e.target)) break;
                e.preventDefault();
                onToggleSplitTimelines();
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
