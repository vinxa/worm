import { state } from "./state.js";
import { addSwipeRightListener, parseGameStart, formatGameDatetime } from "./utils.js";
import { gameHasFollowedPlayer } from "./favourites.js";
import {
    clearFilterSession,
    eventKey,
    hasActiveFilters,
    rememberAutoEventFilterChoice,
    saveFilterSession,
} from "./filterSession.js";

const MENU_ANIMATION_MS = 180;

function updateFiltersButton(summary) {
    summary?.classList.toggle("has-filters", hasActiveFilters());
}

function gameDateKey(game) {
    return formatGameDatetime(game.id)
        .replace(/[\u00A0\s]*\d{2}:\d{2}$/, "")
        .replace(/,\s*$/, "");
}

function eventLabel(event) {
    return event?.label || event?.name || event?.id || "";
}

function matchesEvent(game, eventId) {
    if (eventId === "none") return true;
    const event = state.events.find((e) => eventKey(e) === eventId);
    if (!event) return false;

    const gameStart = parseGameStart(game);
    if (!gameStart) return false;

    return (event.ranges || []).some((r) => {
        const start = new Date(r.start);
        const end = new Date(r.end);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
        return gameStart >= start && gameStart <= end;
    });
}

function currentFilterValues() {
    return {
        type: state.gameFilter,
        event: state.eventFilter,
        date: state.gameDateFilter,
        favourites: state.favouritesOnly === true,
    };
}

function filterGames(games, overrides = {}) {
    const filters = { ...currentFilterValues(), ...overrides };
    return games.filter(
        (game) =>
            (filters.type === "all" ||
                (game.title || "").toLowerCase() === filters.type.toLowerCase()) &&
            matchesEvent(game, filters.event) &&
            (filters.date === "all" || gameDateKey(game) === filters.date) &&
            (!filters.favourites || gameHasFollowedPlayer(game))
    );
}

function setSelectOptions(select, options, selected) {
    select.replaceChildren(...options.map(({ value, label }) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
    }));
    select.value = options.some(({ value }) => value === selected) ? selected : options[0]?.value || "";
}

export function applyFilter(games, overrides = {}) {
    return filterGames(games, overrides);
}

export function populateFilterOptions(games) {
    const gameFilter = document.getElementById("gameFilter");
    const eventFilter = document.getElementById("eventFilter");
    const dateFilter = document.getElementById("dateFilter");
    if (!gameFilter) return;

    const filters = currentFilterValues();

    // Facet each option list by every other active filter. Removing only the
    // filter whose options are being built keeps that selection changeable
    // without offering combinations that cannot match a game.
    const typeOptionsMap = new Map();
    filterGames(games, { type: "all" }).forEach((g) => {
        if (!g.title) return;
        const key = g.title.toLowerCase();
        if (!typeOptionsMap.has(key)) typeOptionsMap.set(key, g.title);
    });
    const typeOptions = [...typeOptionsMap.values()];
    if (filters.type !== "all" && !typeOptions.includes(filters.type)) {
        typeOptions.push(filters.type);
    }
    typeOptions.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    typeOptions.unshift("all");
    setSelectOptions(
        gameFilter,
        typeOptions.map((value) => ({ value, label: value === "all" ? "All types" : value })),
        filters.type,
    );

    if (dateFilter) {
        const dateOptions = [
            "all",
            ...new Set(filterGames(games, { date: "all" }).map(gameDateKey)),
        ];
        if (filters.date !== "all" && !dateOptions.includes(filters.date)) {
            dateOptions.push(filters.date);
        }
        setSelectOptions(
            dateFilter,
            dateOptions.map((value) => ({ value, label: value === "all" ? "All dates" : value })),
            filters.date,
        );
    }

    if (eventFilter) {
        const eventScopedGames = filterGames(games, { event: "none" });

        const options = [{ value: "none", label: "All events" }];
        const seen = new Set(["none"]);
        state.events.forEach((event) => {
            const value = eventKey(event);
            const label = eventLabel(event);
            if (!value || !label || seen.has(value)) return;
            if (!eventScopedGames.some((g) => matchesEvent(g, value))) return;
            seen.add(value);
            options.push({ value, label });
        });
        if (filters.event !== "none" && !options.some((opt) => opt.value === filters.event)) {
            const selectedEvent = state.events.find((event) => eventKey(event) === filters.event);
            options.push({
                value: filters.event,
                label: selectedEvent ? eventLabel(selectedEvent) : filters.event,
            });
        }

        setSelectOptions(eventFilter, options, filters.event);
    }

    updateFiltersButton(document.querySelector(".filters-section summary"));
}

export function setupFilterListeners({ onFiltersChanged } = {}) {
    const gameFilter = document.getElementById("gameFilter");
    const eventFilter = document.getElementById("eventFilter");
    const dateFilter = document.getElementById("dateFilter");
    const clearFiltersButton = document.getElementById("clearFiltersButton");
    const filtersSection = document.querySelector(".filters-section");
    const filtersSummary = filtersSection?.querySelector("summary");
    const notifyFiltersChanged = typeof onFiltersChanged === "function" ? onFiltersChanged : () => {};

    if (filtersSection && filtersSummary) {
        let closeTimer = null;
        const closeSection = () => {
            window.clearTimeout(closeTimer);
            filtersSection.classList.add("is-closing");
            closeTimer = window.setTimeout(() => {
                filtersSection.open = false;
                filtersSection.classList.remove("is-closing");
                document.body.classList.remove("filters-menu-open");
            }, MENU_ANIMATION_MS);
        };
        filtersSummary.addEventListener("click", (event) => {
            event.preventDefault();
            window.clearTimeout(closeTimer);
            if (filtersSection.open) return closeSection();
            filtersSection.classList.remove("is-closing");
            filtersSection.open = true;
            document.body.classList.add("filters-menu-open");
        });
        document.addEventListener("click", (event) => {
            if (filtersSection.open && !filtersSection.contains(event.target)) closeSection();
        });
        addSwipeRightListener(filtersSection, () => {
            if (filtersSection.open) closeSection();
        });
    }
    updateFiltersButton(filtersSummary);

    [[gameFilter, "gameFilter", "all"], [eventFilter, "eventFilter", "none"], [dateFilter, "gameDateFilter", "all"]]
        .forEach(([element, key, fallback]) => element?.addEventListener("change", (e) => {
            state[key] = e.target.value || fallback;
            if (key === "eventFilter") {
                rememberAutoEventFilterChoice(state.events, state.eventFilter);
            }
            saveFilterSession();
            updateFiltersButton(filtersSummary);
            notifyFiltersChanged();
        }));

    clearFiltersButton?.addEventListener("click", () => {
        clearFilterSession();
        if (rememberAutoEventFilterChoice(state.events, state.eventFilter)) {
            saveFilterSession();
        }
        const favouritesOnly = document.getElementById("favouritesOnlyFilter");
        if (favouritesOnly) favouritesOnly.checked = false;
        updateFiltersButton(filtersSummary);
        notifyFiltersChanged();
    });
}
