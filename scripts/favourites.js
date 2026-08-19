import { state } from "./state.js";
import { addSwipeRightListener, normaliseText } from "./utils.js";
import {
    latestSummaryPlayerRecords,
    summaryPlayerAliases,
    summaryPlayerRecordMap,
} from "./summaryPlayers.js";
import {
    clearFollowedPlayers,
    loadFollowedPlayers,
    removeFollowedPlayer,
    saveFollowedPlayer,
} from "./favouritesStore.js";
import { hasActiveFilters, saveFilterSession } from "./filterSession.js";

let currentGames = [];
let allCurrentGames = [];
let restrictCandidatesToCurrentGames = false;
let onFavouritesChanged = null;
let elements = null;
let panelAnimationTimer = null;
let showSelectedOnly = false;
let isHydratingPlayers = false;
let identityHydrationPromise = null;
let favouritesScopeVersion = 0;
const hydratedPlayers = new Map();
const hydratedPlayerGameIds = new Map();
const hydratedPlayerIdsByGameId = new Map();
const hydratedGamePaths = new Set();
const PANEL_ANIMATION_MS = 180;
const IDENTITY_FALLBACK_GAME_LIMIT = 12;
const IDENTITY_FALLBACK_PLAYER_TARGET = 40;
const IDENTITY_FALLBACK_BATCH_SIZE = 3;

function warnOnFailure(promise, message) {
    return promise.catch((error) => console.warn(message, error));
}

function hasPlayerIdentity(playerId, player) {
    return String(playerId || "").startsWith("#") ||
        String(player?.id || "").startsWith("#") ||
        Boolean(player?.memberId);
}

export function followablePlayers(games = [], aliasGames = games) {
    const scoped = latestSummaryPlayerRecords(games);
    const latest = latestSummaryPlayerRecords(aliasGames);
    return Object.entries(scoped)
        .filter(([id, player]) => hasPlayerIdentity(id, player))
        .map(([id, player]) => {
            const latestPlayer = latest[id] || {};
            const memberId = latestPlayer.memberId || player.memberId;
            return {
                id,
                alias: String(latestPlayer.alias || player.alias || id).trim(),
                ...(memberId ? { memberId } : {}),
            };
        })
        .sort((left, right) => left.alias.localeCompare(right.alias, undefined, { sensitivity: "base" }));
}

export function gameHasFollowedPlayer(game, followedPlayers = state.followedPlayers) {
    if (!(followedPlayers instanceof Map) || followedPlayers.size === 0) return false;
    const gameRecords = summaryPlayerRecordMap(game?.players);
    if (Object.keys(gameRecords).some((playerId) => followedPlayers.has(playerId))) return true;

    const followedAliases = new Set(
        [...followedPlayers.values()].map((player) => normaliseText(player.alias)).filter(Boolean)
    );
    return summaryPlayerAliases(game?.players).some((alias) => followedAliases.has(normaliseText(alias)));
}

function candidatePlayers() {
    const candidates = new Map(
        followablePlayers(currentGames, allCurrentGames).map((player) => [player.id, player])
    );
    hydratedPlayers.forEach((player, playerId) => {
        if (
            restrictCandidatesToCurrentGames &&
            !currentGames.some((game) =>
                hydratedPlayerIdsByGameId.get(String(game?.id || ""))?.has(playerId)
            )
        ) return;
        if (!candidates.has(playerId)) candidates.set(playerId, player);
    });
    state.followedPlayers.forEach((player, playerId) => {
        if (!hasPlayerIdentity(playerId, player)) return;
        if (restrictCandidatesToCurrentGames) {
            const selectedPlayer = new Map([[playerId, player]]);
            if (!currentGames.some((game) => gameHasFollowedPlayer(game, selectedPlayer))) return;
        }
        if (!candidates.has(playerId)) candidates.set(playerId, player);
    });
    return [...candidates.values()].sort(
        (left, right) => left.alias.localeCompare(right.alias, undefined, { sensitivity: "base" })
    );
}

function loadMissingPlayerIdentities() {
    if (identityHydrationPromise) return identityHydrationPromise;
    const hydrationScopeVersion = favouritesScopeVersion;
    const candidates = [...currentGames]
        .sort((left, right) => String(right?.id || "").localeCompare(String(left?.id || "")))
        .filter((game) =>
            typeof game?.dataPath === "string" &&
            game.dataPath &&
            !hydratedGamePaths.has(game.dataPath) &&
            followablePlayers([game]).length === 0
        )
        .slice(0, IDENTITY_FALLBACK_GAME_LIMIT);
    if (!candidates.length) return Promise.resolve();
    const candidateGameIds = new Set(candidates.map((game) => String(game?.id || "")));

    isHydratingPlayers = true;
    renderPlayers();
    identityHydrationPromise = (async () => {
        for (let index = 0; index < candidates.length; index += IDENTITY_FALLBACK_BATCH_SIZE) {
            await Promise.allSettled(
                candidates
                    .slice(index, index + IDENTITY_FALLBACK_BATCH_SIZE)
                    .map(async (game) => {
                        if (hydratedGamePaths.has(game.dataPath)) return;
                        hydratedGamePaths.add(game.dataPath);
                        const response = await fetch(game.dataPath, { cache: "force-cache" });
                        if (!response.ok) return;
                        const payload = await response.json();
                        const gameId = String(game.id || "");
                        const playerIds = new Set();
                        followablePlayers([{ id: game.id, players: payload?.players }])
                            .forEach((player) => {
                                playerIds.add(player.id);
                                const previousGameId = hydratedPlayerGameIds.get(player.id) || "";
                                if (
                                    !hydratedPlayers.has(player.id) ||
                                    gameId.localeCompare(previousGameId) > 0
                                ) {
                                    hydratedPlayers.set(player.id, player);
                                    hydratedPlayerGameIds.set(player.id, gameId);
                                }
                            });
                        hydratedPlayerIdsByGameId.set(gameId, playerIds);
                    })
            );
            renderPlayers();
            const hydratedCandidatePlayerIds = new Set();
            candidateGameIds.forEach((gameId) => {
                hydratedPlayerIdsByGameId.get(gameId)?.forEach((playerId) => {
                    hydratedCandidatePlayerIds.add(playerId);
                });
            });
            if (hydratedCandidatePlayerIds.size >= IDENTITY_FALLBACK_PLAYER_TARGET) break;
        }
    })().finally(() => {
        isHydratingPlayers = false;
        identityHydrationPromise = null;
        renderPlayers();
        if (
            favouritesScopeVersion !== hydrationScopeVersion &&
            elements?.button.getAttribute("aria-expanded") === "true"
        ) {
            loadMissingPlayerIdentities();
        }
    });
    return identityHydrationPromise;
}

function updateButton() {
    if (!elements) return;
    const count = state.followedPlayers.size;
    elements.count.textContent = String(count);
    elements.count.hidden = count === 0;
    elements.button.classList.toggle("has-favourites", count > 0);
    elements.button.title = state.favouritesOnly
        ? "Showing games with followed players"
        : `${count} followed player${count === 1 ? "" : "s"}`;
    elements.only.checked = state.favouritesOnly;
    elements.selectedOnly.classList.toggle("is-active", showSelectedOnly);
    elements.selectedOnly.setAttribute("aria-pressed", String(showSelectedOnly));
    elements.selectedOnly.title = showSelectedOnly
        ? "Show all players"
        : "Show selected players only";
    elements.selectedOnly.setAttribute("aria-label", elements.selectedOnly.title);
    elements.clear.disabled = count === 0;
    document.querySelector(".filters-section > summary")
        ?.classList.toggle("has-filters", hasActiveFilters());
}

function renderPlayers() {
    if (!elements) return;
    const query = normaliseText(elements.search.value);
    const players = candidatePlayers().filter((player) =>
        (!showSelectedOnly || state.followedPlayers.has(player.id)) &&
        (!query || normaliseText(player.alias).includes(query))
    );
    elements.players.replaceChildren();
    players.forEach((player) => {
        const label = document.createElement("label");
        label.className = "favourite-player-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = state.followedPlayers.has(player.id);
        checkbox.dataset.playerId = player.id;
        const star = document.createElement("span");
        star.className = "favourite-player-star";
        star.textContent = "★";
        const name = document.createElement("span");
        name.className = "favourite-player-name";
        name.textContent = player.alias;
        label.append(checkbox, star, name);
        if (player.memberId) {
            const memberId = document.createElement("small");
            memberId.className = "favourite-player-member";
            memberId.textContent = player.memberId;
            label.appendChild(memberId);
        }
        elements.players.appendChild(label);
    });
    elements.empty.textContent = showSelectedOnly
        ? "No selected players."
        : isHydratingPlayers
            ? "Loading identified players…"
            : "No identified players available.";
    elements.empty.hidden = players.length > 0;
    updateButton();
}

function setPanelOpen(open) {
    if (!elements) return;
    window.clearTimeout(panelAnimationTimer);
    elements.button.setAttribute("aria-expanded", String(open));
    if (open) {
        document.body.classList.add("favourites-menu-open");
        elements.panel.hidden = false;
        elements.panel.classList.remove("is-closing");
        // Commit the hidden panel's starting state before transitioning it in.
        void elements.panel.offsetWidth;
        elements.panel.classList.add("is-open");
        elements.search.focus();
        renderPlayers();
        loadMissingPlayerIdentities();
        return;
    }
    elements.panel.classList.remove("is-open");
    elements.panel.classList.add("is-closing");
    panelAnimationTimer = window.setTimeout(() => {
        elements.panel.hidden = true;
        elements.panel.classList.remove("is-closing");
        document.body.classList.remove("favourites-menu-open");
    }, PANEL_ANIMATION_MS);
}

export function refreshFavouritesPanel(
    games = state.games || [],
    { allGames = games, restrictToGames = false } = {},
) {
    currentGames = games;
    allCurrentGames = allGames;
    restrictCandidatesToCurrentGames = restrictToGames;
    favouritesScopeVersion++;
    const aliasesById = new Map();
    const latest = latestSummaryPlayerRecords(allGames);
    allGames.forEach((game) => {
        Object.entries(summaryPlayerRecordMap(game?.players)).forEach(([playerId, player]) => {
            const alias = normaliseText(player.alias);
            if (alias) aliasesById.set(alias, playerId);
        });
    });
    [...state.followedPlayers.entries()].forEach(([storedId, storedPlayer]) => {
        if (!storedId.startsWith("alias:")) return;
        const playerId = aliasesById.get(normaliseText(storedPlayer.alias));
        if (!playerId) return;
        const latestPlayer = latest[playerId];
        const migrated = {
            id: playerId,
            alias: latestPlayer?.alias || storedPlayer.alias,
            ...(latestPlayer?.memberId ? { memberId: latestPlayer.memberId } : {}),
        };
        state.followedPlayers.delete(storedId);
        const alreadyFollowed = state.followedPlayers.has(playerId);
        if (!alreadyFollowed) state.followedPlayers.set(playerId, migrated);
        const writes = [removeFollowedPlayer(storedPlayer)];
        if (!alreadyFollowed) writes.push(saveFollowedPlayer(migrated));
        warnOnFailure(Promise.all(writes), "Unable to migrate a followed player ID:");
    });
    if (elements?.button.getAttribute("aria-expanded") === "true") {
        renderPlayers();
        loadMissingPlayerIdentities();
    } else {
        updateButton();
    }
}

export async function setupFavourites({ onChange } = {}) {
    elements = {
        button: document.getElementById("favouritesButton"),
        panel: document.getElementById("favouritesPanel"),
        close: document.getElementById("closeFavouritesButton"),
        selectedOnly: document.getElementById("selectedFavouritesFilter"),
        only: document.getElementById("favouritesOnlyFilter"),
        search: document.getElementById("favouritesSearch"),
        players: document.getElementById("favouritesPlayers"),
        empty: document.getElementById("favouritesEmpty"),
        count: document.getElementById("favouritesCount"),
        clear: document.getElementById("clearFavouritesButton"),
    };
    if (Object.entries(elements).some(([name, element]) => name !== "close" && !element)) return;
    onFavouritesChanged = typeof onChange === "function" ? onChange : null;
    elements.button.addEventListener("click", () => {
        setPanelOpen(elements.button.getAttribute("aria-expanded") !== "true");
    });
    elements.close?.addEventListener("click", () => setPanelOpen(false));
    addSwipeRightListener(elements.panel, () => setPanelOpen(false));
    elements.search.addEventListener("input", renderPlayers);
    elements.selectedOnly.addEventListener("click", () => {
        showSelectedOnly = !showSelectedOnly;
        renderPlayers();
    });
    elements.only.addEventListener("change", () => {
        state.favouritesOnly = elements.only.checked;
        saveFilterSession();
        updateButton();
        onFavouritesChanged?.();
    });
    elements.clear.addEventListener("click", async () => {
        state.followedPlayers.clear();
        state.favouritesOnly = false;
        showSelectedOnly = false;
        elements.only.checked = false;
        saveFilterSession();
        await warnOnFailure(clearFollowedPlayers(), "Unable to clear followed players:");
        renderPlayers();
        onFavouritesChanged?.();
    });
    elements.players.addEventListener("change", (event) => {
        const checkbox = event.target.closest("input[data-player-id]");
        if (!checkbox) return;
        const player = candidatePlayers().find((candidate) => candidate.id === checkbox.dataset.playerId);
        if (!player) return;
        const isFollowed = checkbox.checked;
        if (isFollowed) {
            state.followedPlayers.set(player.id, player);
        } else {
            state.followedPlayers.delete(player.id);
        }
        updateButton();
        window.requestAnimationFrame(() => {
            window.setTimeout(() => {
                if (showSelectedOnly) renderPlayers();
                onFavouritesChanged?.({ playerToggle: true });
            }, 0);
        });
        warnOnFailure(
            isFollowed ? saveFollowedPlayer(player) : removeFollowedPlayer(player),
            "Unable to save followed-player preference:",
        );
    });
    document.addEventListener("click", (event) => {
        if (elements.button.getAttribute("aria-expanded") === "true" && !event.target.closest(".favourites-menu")) {
            setPanelOpen(false);
        }
    });

    const stored = await warnOnFailure(loadFollowedPlayers(), "Unable to load followed players:") || [];
    const identified = stored.filter((player) => hasPlayerIdentity(player?.id, player));
    const unidentified = stored.filter((player) => !hasPlayerIdentity(player?.id, player));
    state.followedPlayers = new Map(identified.map((player) => [player.id, player]));
    if (unidentified.length) {
        warnOnFailure(
            Promise.all(unidentified.map(removeFollowedPlayer)),
            "Unable to remove unidentified followed-player records:",
        );
    }
    elements.only.checked = state.favouritesOnly;
    refreshFavouritesPanel(state.games || []);
    onFavouritesChanged?.();
}
