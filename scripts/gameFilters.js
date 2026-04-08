import { state } from "./state.js";
import { formatGameDatetime } from "./utils.js";

function gameDateLabel(game) {
    return formatGameDatetime(game.id);
}

function gameDateKey(game) {
    return gameDateLabel(game).replace(/[\u00A0\s]*\d{2}:\d{2}$/, "");
}

function matchesType(game, typeValue) {
    if (typeValue === "all") return true;
    return (game.title || "").toLowerCase() === typeValue.toLowerCase();
}

function matchesDate(game, dateValue) {
    if (dateValue === "all") return true;
    return gameDateKey(game) === dateValue;
}

function parseGameStart(game) {
    if (!game || !game.id) return null;
    const m = game.id.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    const [, YYYY, MM, DD, hh, mm] = m;
    const parsed = new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function eventKey(event) {
    return event?.id || event?.name || event?.label || "";
}

function eventLabel(event) {
    return event?.label || event?.name || event?.id || "";
}

function matchesEvent(game, eventId) {
    if (eventId === "none") return true;
    const event = (state.events || []).find((e) => eventKey(e) === eventId);
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

function matchesPlayer(game, playerValue) {
    if (playerValue === "all" || !playerValue) return true;
    const list = Array.isArray(game.players) ? game.players : [];
    return list.some((name) => (name || "").toLowerCase() === playerValue.toLowerCase());
}

function currentFilterValues() {
    return {
        type: state.gameFilter || "all",
        event: state.eventFilter || "none",
        date: state.gameDateFilter || "all",
        player: state.gamePlayerFilter || "all",
    };
}

function filterGames(games, overrides = {}) {
    const filters = { ...currentFilterValues(), ...overrides };
    return games.filter(
        (g) =>
            matchesType(g, filters.type) &&
            matchesEvent(g, filters.event) &&
            matchesDate(g, filters.date) &&
            matchesPlayer(g, filters.player)
    );
}

export function applyFilter(games) {
    return filterGames(games);
}

export function populateFilterOptions(games) {
    const gameFilter = document.getElementById("gameFilter");
    const eventFilter = document.getElementById("eventFilter");
    const dateFilter = document.getElementById("dateFilter");
    const playerFilter = document.getElementById("playerFilter");
    const playerOptionsList = document.getElementById("playerOptions");
    if (!gameFilter) return;

    const filters = currentFilterValues();

    const typeScopedGames =
        filters.date === "all" && filters.player === "all" && filters.event === "none"
            ? games
            : filterGames(games, { type: "all" });
    const typeOptionsMap = new Map();
    typeScopedGames.forEach((g) => {
        if (!g.title) return;
        const key = g.title.toLowerCase();
        if (!typeOptionsMap.has(key)) typeOptionsMap.set(key, g.title);
    });
    const typeOptions = ["all", ...typeOptionsMap.values()];
    if (filters.type !== "all" && !typeOptions.includes(filters.type)) {
        typeOptions.push(filters.type);
    }
    gameFilter.innerHTML = typeOptions
        .map((opt) => `<option value="${opt}">${opt === "all" ? "All types" : opt}</option>`)
        .join("");
    gameFilter.value = typeOptions.includes(filters.type) ? filters.type : "all";

    if (dateFilter) {
        const dateScopedGames =
            filters.type === "all" && filters.player === "all" && filters.event === "none"
                ? games
                : filterGames(games, { date: "all" });
        const dateOptions = ["all", ...Array.from(new Set(dateScopedGames.map(gameDateKey)))];
        if (filters.date !== "all" && !dateOptions.includes(filters.date)) {
            dateOptions.push(filters.date);
        }
        dateFilter.innerHTML = dateOptions
            .map((opt) => `<option value="${opt}">${opt === "all" ? "All dates" : opt}</option>`)
            .join("");
        dateFilter.value = dateOptions.includes(filters.date) ? filters.date : "all";
    }

    if (eventFilter) {
        const eventScopedGames =
            filters.type === "all" && filters.date === "all" && filters.player === "all"
                ? games
                : filterGames(games, { event: "none" });

        const options = [{ value: "none", label: "All events" }];
        const seen = new Set(["none"]);
        (state.events || []).forEach((event) => {
            const value = eventKey(event);
            const label = eventLabel(event);
            if (!value || !label || seen.has(value)) return;
            if (!eventScopedGames.some((g) => matchesEvent(g, value))) return;
            seen.add(value);
            options.push({ value, label });
        });
        if (filters.event !== "none" && !options.some((opt) => opt.value === filters.event)) {
            const selectedEvent = (state.events || []).find((event) => eventKey(event) === filters.event);
            options.push({
                value: filters.event,
                label: selectedEvent ? eventLabel(selectedEvent) : filters.event,
            });
        }

        eventFilter.innerHTML = options
            .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
            .join("");

        eventFilter.value = options.some((opt) => opt.value === filters.event) ? filters.event : "none";
    }

    if (playerFilter) {
        const playerScopedGames =
            filters.type === "all" && filters.date === "all" && filters.event === "none"
                ? games
                : filterGames(games, { player: "all" });
        const playersSet = new Set();
        playerScopedGames.forEach((g) => {
            (Array.isArray(g.players) ? g.players : []).forEach((name) => {
                if (name) playersSet.add(name);
            });
        });
        const playerOptions = ["all", ...playersSet];
        if (playerOptionsList) {
            playerOptionsList.innerHTML = playerOptions
                .filter((opt) => opt !== "all")
                .map((opt) => `<option value="${opt}"></option>`)
                .join("");
        }
        const currentText = state.gamePlayerFilterText || "";
        playerFilter.value = currentText;
        if (currentText === "") {
            state.gamePlayerFilter = "all";
        }
    }
}

export function setupFilterListeners({ onFiltersChanged } = {}) {
    const gameFilter = document.getElementById("gameFilter");
    const eventFilter = document.getElementById("eventFilter");
    const dateFilter = document.getElementById("dateFilter");
    const playerFilter = document.getElementById("playerFilter");

    if (gameFilter) {
        gameFilter.addEventListener("change", (e) => {
            state.gameFilter = e.target.value || "all";
            if (typeof onFiltersChanged === "function") onFiltersChanged();
        });
    }

    if (eventFilter) {
        eventFilter.addEventListener("change", (e) => {
            state.eventFilter = e.target.value || "none";
            if (typeof onFiltersChanged === "function") onFiltersChanged();
        });
    }

    if (dateFilter) {
        dateFilter.addEventListener("change", (e) => {
            state.gameDateFilter = e.target.value || "all";
            if (typeof onFiltersChanged === "function") onFiltersChanged();
        });
    }

    if (playerFilter) {
        const updatePlayerFilter = (value) => {
            const trimmed = (value || "").trim();
            state.gamePlayerFilterText = value || "";
            state.gamePlayerFilter = trimmed === "" ? "all" : trimmed;
            if (typeof onFiltersChanged === "function") onFiltersChanged();
        };
        playerFilter.addEventListener("change", (e) => updatePlayerFilter(e.target.value));
        playerFilter.addEventListener("input", (e) => updatePlayerFilter(e.target.value));
        playerFilter.addEventListener("focus", (e) => {
            e.target.value = state.gamePlayerFilterText || "";
        });
    }
}
