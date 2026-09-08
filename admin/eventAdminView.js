// @ts-check

import { cloneTemplate, required, requiredControl, setText } from "./eventAdminDom.js";
import { exampleGames, playerCount, SUB_EVENT_TYPES } from "./eventEditorModel.js";
import { markChanged, openEvent, openSection, refreshExamples, updateStatus } from "./eventAdminCore.js";

/**
 * @typedef {import("./eventAdminContext.js").AdminContext} AdminContext
 * @typedef {import("./eventEditorModel.js").EventRecord} EventRecord
 * @typedef {import("./eventEditorModel.js").Player} Player
 * @typedef {import("./eventEditorModel.js").SubEvent} SubEvent
 */

/** @param {HTMLSelectElement} select */
function populateTimezones(select) {
    if (select.options.length) return;
    const fallback = [
        "Australia/Adelaide", "Australia/Brisbane", "Australia/Melbourne",
        "Australia/Perth", "Australia/Sydney", "Europe/London", "Pacific/Auckland",
    ];
    const supported = typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : fallback;
    const zones = ["UTC", ...supported.filter((timezone) => timezone !== "UTC")];
    select.replaceChildren(...zones.map((timezone) => {
        const option = document.createElement("option");
        option.value = timezone;
        option.textContent = timezone;
        return option;
    }));
}

/** @param {AdminContext} context @param {Player[]} players @param {string} [sourceTeamId] @returns {HTMLElement} */
function renderPlayers(context, players, sourceTeamId) {
    const list = cloneTemplate(context.root, "player-list");
    const rows = required(list, "[data-player-rows]");
    players.forEach((player, index) => {
        const row = cloneTemplate(context.root, "player-row");
        const name = requiredControl(row, '[data-field="player-name"]');
        const memberId = requiredControl(row, '[data-field="member-id"]');
        const remove = required(row, '[data-action="remove-player"]');
        const dragHandle = required(row, "[data-player-drag-handle]");
        name.value = player.name;
        memberId.value = player.memberId;
        dragHandle.hidden = !sourceTeamId;
        if (sourceTeamId) {
            dragHandle.addEventListener("dragstart", (event) => {
                if (!(event instanceof DragEvent) || !event.dataTransfer) return;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", JSON.stringify({ teamId: sourceTeamId, playerIndex: index }));
                row.classList.add("is-dragging");
            });
            dragHandle.addEventListener("dragend", () => { row.classList.remove("is-dragging"); });
        }
        name.addEventListener("input", () => {
            player.name = name.value;
            markChanged(context);
        });
        memberId.addEventListener("input", () => {
            player.memberId = memberId.value;
            refreshExamples(context);
            markChanged(context);
        });
        remove.setAttribute("aria-label", "Remove " + (player.name || "player"));
        remove.addEventListener("click", () => {
            players.splice(index, 1);
            refreshExamples(context);
            markChanged(context);
            context.render();
        });
        rows.append(row);
    });
    required(list, '[data-action="add-player"]').addEventListener("click", () => {
        players.push({ name: "", memberId: "" });
        markChanged(context);
        context.render();
    });
    return list;
}

/** @param {AdminContext} context */
function renderShell(context) {
    const { state, dom } = context;
    dom.views.forEach((node, view) => {
        node.hidden = view === "auth"
            ? state.authenticated
            : view === "list"
                ? !state.authenticated || state.view !== "list"
                : !state.authenticated || state.view === "list";
    });
    dom.lock.hidden = !state.authenticated;
    dom.create.hidden = state.role !== "admin";
    dom.organiserCredential.hidden = !state.authenticated || !state.organiserCredential;
    if (state.organiserCredential) {
        dom.organiserEventName.textContent = state.organiserCredential.eventName;
        dom.organiserPassword.value = state.organiserCredential.password;
    } else {
        dom.organiserEventName.textContent = "";
        dom.organiserPassword.value = "";
    }
    dom.authSetup.hidden = Boolean(context.apiUrl);
    if (!context.apiUrl) dom.authForm.remove();
    dom.authTitle.textContent = state.draft ? "Continue your draft" : "Sign in";
}

/** @param {AdminContext} context */
function renderEventList(context) {
    context.dom.eventList.replaceChildren();
    const events = [...context.state.events].sort((left, right) => left.name.localeCompare(right.name));
    events.forEach((event) => {
        const card = cloneTemplate(context.root, "event-card");
        setText(card, "[data-event-name]", event.name);
        const metadata = [
            event.timezone,
            (event.useTeams ? event.teams.length + " teams · " : "") + playerCount(event) + " players",
            event.subEvents.length + " sub-events",
        ].map((value) => {
            const item = document.createElement("span");
            item.textContent = value;
            return item;
        });
        required(card, "[data-event-meta]").replaceChildren(...metadata);
        const edit = required(card, '[data-action="edit-event"]');
        edit.dataset.eventId = event.eventId;
        edit.addEventListener("click", () => openEvent(context, event.eventId));
        context.dom.eventList.append(card);
    });
    context.dom.eventEmpty.hidden = events.length > 0;
}

/** @param {AdminContext} context @param {EventRecord} event */
function renderEventDetails(context, event) {
    const { dom } = context;
    dom.eventName.value = event.name;
    const timezone = /** @type {HTMLSelectElement} */ (dom.timezone);
    populateTimezones(timezone);
    if (![...timezone.options].some((option) => option.value === event.timezone)) {
        const option = document.createElement("option");
        option.value = event.timezone;
        option.textContent = event.timezone;
        timezone.append(option);
    }
    dom.timezone.value = event.timezone;
    dom.useTeams.checked = event.useTeams;
    dom.teamsLinkTitle.textContent = event.useTeams ? "Teams & players" : "Individual players";
    dom.teamsLinkCopy.textContent = (event.useTeams ? event.teams.length + " teams · " : "")
        + playerCount(event) + " players";
    dom.subeventsLinkCopy.textContent = event.subEvents.length + " sub-events";
    context.calendar = context.calendarFactory(dom.calendarHost, {
        getEvent: () => context.state.draft,
        /** @param {EventRecord} next */
        onChange: (next) => {
            if (context.state.busy) return;
            context.state.draft = next;
            markChanged(context);
        },
        /** @param {string} subEventId */
        onEditSubEvent: (subEventId) => {
            openSection(context, "subevents");
            context.root.querySelector('[data-subevent-id="' + CSS.escape(subEventId) + '"]')
                ?.scrollIntoView({ block: "start" });
        },
    });
}

/** @param {AdminContext} context @param {EventRecord} event */
function renderTeams(context, event) {
    const teamsButton = required(context.root, '[data-action="use-teams"]');
    const individualsButton = required(context.root, '[data-action="no-teams"]');
    teamsButton.classList.toggle("button--primary", event.useTeams);
    individualsButton.classList.toggle("button--primary", !event.useTeams);
    teamsButton.setAttribute("aria-pressed", String(event.useTeams));
    individualsButton.setAttribute("aria-pressed", String(!event.useTeams));
    context.dom.individualRoster.hidden = event.useTeams;
    context.dom.teamListHeading.hidden = !event.useTeams;
    context.dom.teamList.hidden = !event.useTeams;
    context.dom.teamEmpty.hidden = !event.useTeams || event.teams.length > 0;
    context.dom.individualPlayers.replaceChildren();
    context.dom.teamList.replaceChildren();
    if (!event.useTeams) {
        context.dom.individualPlayers.append(renderPlayers(context, event.players));
        return;
    }
    context.dom.teamCount.textContent = event.teams.length + " teams registered";
    event.teams.forEach((team) => {
        const card = cloneTemplate(context.root, "team-card");
        const name = requiredControl(card, '[data-field="team-name"]');
        name.value = team.name;
        name.addEventListener("input", () => {
            team.name = name.value;
            markChanged(context);
        });
        required(card, '[data-action="remove-team"]').addEventListener("click", () => {
            if (!context.confirmLeave("Remove “" + (team.name || "this team") + "” and its roster?")) return;
            event.teams = event.teams.filter((entry) => entry !== team);
            event.subEvents.forEach((subEvent) => {
                subEvent.teamIds = (subEvent.teamIds || []).filter((teamId) => teamId !== team.teamId);
            });
            refreshExamples(context);
            markChanged(context);
            context.render();
        });
        const dropzone = required(card, "[data-team-players]");
        dropzone.classList.add("admin-team-dropzone");
        dropzone.addEventListener("dragover", (dragEvent) => {
            if (!(dragEvent instanceof DragEvent) || !dragEvent.dataTransfer) return;
            dragEvent.preventDefault();
            dragEvent.dataTransfer.dropEffect = "move";
            dropzone.classList.add("is-drag-over");
        });
        dropzone.addEventListener("dragleave", () => { dropzone.classList.remove("is-drag-over"); });
        dropzone.addEventListener("drop", (dragEvent) => {
            dropzone.classList.remove("is-drag-over");
            if (!(dragEvent instanceof DragEvent) || !dragEvent.dataTransfer) return;
            dragEvent.preventDefault();
            let transfer;
            try {
                transfer = JSON.parse(dragEvent.dataTransfer.getData("text/plain"));
            } catch {
                return;
            }
            const source = event.teams.find((entry) => entry.teamId === transfer?.teamId);
            const playerIndex = Number(transfer?.playerIndex);
            if (!source || source === team || !Number.isInteger(playerIndex) || !source.players[playerIndex]) return;
            const [player] = source.players.splice(playerIndex, 1);
            team.players.push(player);
            refreshExamples(context);
            markChanged(context);
            context.render();
        });
        dropzone.append(renderPlayers(context, team.players, team.teamId));
        context.dom.teamList.append(card);
    });
}

/** @param {AdminContext} context @param {HTMLElement} card @param {EventRecord} event @param {SubEvent} subEvent */
function renderTeamAllocation(context, card, event, subEvent) {
    const allocation = required(card, "[data-subevent-team-allocation]");
    const options = required(card, "[data-subevent-team-options]");
    const empty = required(card, "[data-subevent-team-empty]");
    allocation.hidden = !event.useTeams;
    options.replaceChildren();
    empty.hidden = event.teams.length > 0;
    const availableTeamIds = event.teams.map((team) => team.teamId);
    subEvent.teamIds = event.useTeams
        ? (Array.isArray(subEvent.teamIds) ? subEvent.teamIds : availableTeamIds)
            .filter((teamId) => availableTeamIds.includes(teamId))
        : [];
    event.teams.forEach((team) => {
        const label = document.createElement("label");
        label.className = "admin-team-allocation-option";
        const input = document.createElement("input");
        input.className = "checkbox-control";
        input.type = "checkbox";
        input.value = team.teamId;
        input.setAttribute("aria-label", "Include " + (team.name || "unnamed team"));
        input.checked = subEvent.teamIds.includes(team.teamId);
        input.addEventListener("change", () => {
            subEvent.teamIds = input.checked
                ? [...new Set([...subEvent.teamIds, team.teamId])]
                : subEvent.teamIds.filter((teamId) => teamId !== team.teamId);
            subEvent.games = exampleGames(event, subEvent);
            markChanged(context);
            context.render();
        });
        label.append(input, document.createTextNode(team.name || "Unnamed team"));
        options.append(label);
    });
}

/** @param {AdminContext} context @param {HTMLElement} card @param {EventRecord} event @param {SubEvent} subEvent */
function renderSampleGames(context, card, event, subEvent) {
    const games = required(card, "[data-sample-list]");
    subEvent.games.forEach((game) => {
        const row = cloneTemplate(context.root, "sample-game");
        setText(row, "[data-game-number]", String(game.gameNumber).padStart(2, "0"));
        const names = event.useTeams
            ? game.teamIds.map((id) => event.teams.find((team) => team.teamId === id)?.name || "Unnamed team")
            : game.memberIds.map((id) => event.players.find((player) => player.memberId.trim() === id)?.name || id);
        setText(row, "[data-game-names]", names.join(" v "));
        games.append(row);
    });
    const empty = required(card, "[data-sample-empty]");
    empty.hidden = subEvent.games.length > 0;
    empty.textContent = "Add at least two " + (event.useTeams ? "teams" : "players")
        + " to preview sample matches.";
}

/** @param {AdminContext} context @param {EventRecord} event */
function renderSubEvents(context, event) {
    context.dom.subeventList.replaceChildren();
    event.subEvents.forEach((subEvent) => {
        const card = cloneTemplate(context.root, "subevent-card");
        card.dataset.subeventId = subEvent.subEventId;
        const name = requiredControl(card, '[data-field="subevent-name"]');
        const type = requiredControl(card, '[data-field="subevent-type"]');
        name.value = subEvent.name;
        name.addEventListener("input", () => {
            subEvent.name = name.value;
            markChanged(context);
        });
        type.replaceChildren(...SUB_EVENT_TYPES.map((value) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            option.selected = value === subEvent.type;
            return option;
        }));
        type.addEventListener("change", () => {
            subEvent.type = type.value;
            subEvent.games = exampleGames(event, subEvent);
            markChanged(context);
            context.render();
        });
        setText(card, "[data-subevent-periods]", subEvent.periods.length
            + (subEvent.periods.length === 1 ? " time slot" : " time slots")
            + " · Edit on the event schedule.");
        renderTeamAllocation(context, card, event, subEvent);
        renderSampleGames(context, card, event, subEvent);
        required(card, '[data-action="regenerate"]').addEventListener("click", () => {
            subEvent.games = exampleGames(event, subEvent);
            markChanged(context);
            context.render();
        });
        required(card, '[data-action="remove-subevent"]').addEventListener("click", () => {
            const remaining = event.subEvents.filter((entry) => entry !== subEvent);
            const destination = remaining.length ? "“" + remaining[0].name + "”" : "the parent event";
            if (!context.confirmLeave("Remove “" + subEvent.name
                + "” and its sample matches? Its time slots will move to " + destination + ".")) return;
            event.subEvents = remaining;
            if (remaining.length) remaining[0].periods.push(...subEvent.periods);
            else event.periods = [...subEvent.periods];
            markChanged(context);
            context.render();
        });
        context.dom.subeventList.append(card);
    });
    context.dom.subeventEmpty.hidden = event.subEvents.length > 0;
}

/** @param {AdminContext} context @param {EventRecord} event */
function renderEditor(context, event) {
    const heading = context.state.view === "teams"
        ? (event.useTeams ? "Teams & players" : "Individual players")
        : context.state.view === "subevents" ? "Sub-events" : event.name || "Untitled event";
    context.dom.back.textContent = context.state.view === "event" ? "← All events" : "← Back to event";
    context.dom.draftTitle.textContent = heading;
    context.dom.draftContext.hidden = context.state.view === "event";
    context.dom.draftContext.textContent = event.name || "Untitled event";
    context.dom.editorSections.forEach((node, view) => { node.hidden = view !== context.state.view; });

    if (context.state.view === "event") renderEventDetails(context, event);
    else if (context.state.view === "teams") renderTeams(context, event);
    else if (context.state.view === "subevents") renderSubEvents(context, event);
}

/** @param {AdminContext} context */
export function renderAdmin(context) {
    context.calendar?.destroy();
    context.calendar = null;
    if (context.state.authenticated && context.state.view !== "list" && !context.state.draft) {
        context.state.view = "list";
    }
    renderShell(context);
    if (context.state.authenticated && context.state.view === "list") renderEventList(context);
    if (context.state.authenticated && context.state.view !== "list" && context.state.draft) {
        renderEditor(context, context.state.draft);
    }
    updateStatus(context);
}
