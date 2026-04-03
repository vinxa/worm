// ui.js

import { state } from "./state.js";
import { handleSkip, jumpToStart, jumpToEnd, goToLatestGame } from "./replayHandler.js";
import { setupKeyboardControls } from "./keyboard.js";
import { createHomeUi } from "./homeUi.js";
import { showGame, renderGameData, updateNextGameButtonVisibility, clickPlayButton, stepPlaybackRateUi, bindPlaybackButtons } from "./gameUi.js";
import { setupFilterListeners } from "./gameFilters.js";
import { setupLogoDance } from "./wormThings.js";

const nextGameBtn = document.querySelector(".next-game-button");
const { showHome, buildGrid } = createHomeUi({ showGame, updateNextGameButtonVisibility });

function loadGameAtIndex(idx) {
    const games = state.games || [];
    if (idx < 0 || idx >= games.length) return false;
    state.selectedPlayers = new Set();
    showGame(games[idx]);
    return true;
}

export { showHome, showGame, buildGrid, renderGameData, updateNextGameButtonVisibility };

export function initUI() {
    const leftNavigationButton = document.querySelector(".nav-button.left");
    leftNavigationButton.addEventListener("click", () => showHome(state.selectedGame));

    bindPlaybackButtons();
    setupLogoDance();

    const rewindButton = document.getElementById("rewindButton");
    rewindButton.addEventListener("click", () => handleSkip(-15));

    const forwardButton = document.getElementById("forwardButton");
    forwardButton.addEventListener("click", () => handleSkip(+15));

    const skipStartButton = document.getElementById("skipStartButton");
    if (skipStartButton) skipStartButton.addEventListener("click", () => jumpToStart({ loadGameAtIndex }));

    const skipEndButton = document.getElementById("skipEndButton");
    if (skipEndButton) skipEndButton.addEventListener("click", () => jumpToEnd({ loadGameAtIndex }));

    if (nextGameBtn) {
        nextGameBtn.addEventListener("click", () => goToLatestGame({ showGame }));
    }
    setupFilterListeners({ onFiltersChanged: () => buildGrid(state.games || []) });

    setupKeyboardControls({
        onTogglePlay: clickPlayButton,
        onJumpToStart: () => jumpToStart({ loadGameAtIndex }),
        onJumpToEnd: () => jumpToEnd({ loadGameAtIndex }),
        onSpeedUp: () => stepPlaybackRateUi(1),
        onSpeedDown: () => stepPlaybackRateUi(-1),
        onLatestGame: () => goToLatestGame({ showGame }),
        onShowHome: showHome,
    });
}
