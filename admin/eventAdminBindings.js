// @ts-check

import { required } from "./eventAdminDom.js";
import { editableEvent, exampleGames, SUB_EVENT_TYPES, uid } from "./eventEditorModel.js";
import { playRandomLogoDance } from "../scripts/logoDance.js";
import {
    adopt,
    canDiscard,
    markChanged,
    openEvent,
    openSection,
    perform,
    readEvents,
    showStatus,
    switchTeamMode,
} from "./eventAdminCore.js";

/**
 * @typedef {import("./eventAdminContext.js").AdminContext} AdminContext
 * @typedef {import("./eventEditorModel.js").SubEvent} SubEvent
 */

/** @param {AdminContext} context */
export function bindSessionActions(context) {
    const { dom, state } = context;
    required(context.root, '[data-action="open-worm"]').addEventListener("click", (event) => {
        if (!canDiscard(context)) event.preventDefault();
    });
    dom.copyOrganiserPassword.addEventListener("click", async () => {
        const credential = state.organiserCredential;
        if (!credential) return;
        try {
            if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
            await navigator.clipboard.writeText(credential.password);
            showStatus(context, "Organiser password copied.");
        } catch {
            dom.organiserPassword.focus();
            dom.organiserPassword.select();
            showStatus(context, "Copy the selected organiser password manually.", true);
        }
    });
    dom.hideOrganiserPassword.addEventListener("click", () => {
        state.organiserCredential = null;
        context.render();
    });
    dom.lock.addEventListener("click", () => {
        context.api.lock();
        state.authenticated = false;
        state.role = null;
        state.events = [];
        state.organiserCredential = null;
        state.status = "Event editor locked. Your draft is ready to continue.";
        state.error = false;
        context.render();
    });
    dom.authForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.busy || !dom.password.value) return;
        const secret = dom.password.value;
        dom.password.value = "";
        await perform(context, "Signing in…", async () => {
            const session = await context.api.authenticate(secret);
            if (session.role !== "admin" && session.role !== "organiser") {
                throw new Error("The event list couldn’t be read. Please try again.");
            }
            state.role = session.role;
            state.events = readEvents(session);
            state.authenticated = true;
            state.status = state.draft ? "Your draft is ready to continue." : "";
            state.error = false;
        });
    });
    dom.create.addEventListener("click", () => {
        if (!canDiscard(context)) return;
        state.organiserCredential = null;
        state.draft = {
            schemaVersion: 1,
            eventId: uid(),
            name: "",
            timezone: "Australia/Perth",
            useTeams: true,
            players: [],
            teams: [],
            periods: [],
            subEvents: [],
        };
        state.revision = null;
        state.view = "event";
        markChanged(context);
        context.render();
    });
    required(context.root, '[data-action="refresh-events"]').addEventListener("click", () => perform(context, "", async () => {
        state.events = readEvents(await context.api.listEvents());
        state.status = "";
    }));
}

/** @param {AdminContext} context */
export function bindNavigationActions(context) {
    const { dom, state } = context;
    dom.reload.addEventListener("click", () => {
        if (state.draft) openEvent(context, state.draft.eventId);
    });
    dom.back.addEventListener("click", () => {
        if (state.view !== "event") {
            openSection(context, "event");
            return;
        }
        if (state.busy || !canDiscard(context)) return;
        state.draft = null;
        state.dirty = false;
        state.view = "list";
        state.status = "";
        context.render();
    });
    required(context.root, '[data-action="open-teams"]').addEventListener("click", () => openSection(context, "teams"));
    required(context.root, '[data-action="open-subevents"]').addEventListener("click", () => openSection(context, "subevents"));
    required(context.root, '[data-action="use-teams"]').addEventListener("click", () => switchTeamMode(context, true));
    required(context.root, '[data-action="no-teams"]').addEventListener("click", () => switchTeamMode(context, false));
    required(context.root, '[data-action="add-team"]').addEventListener("click", () => {
        if (!state.draft) return;
        state.draft.teams.push({ teamId: uid(), name: "", players: [] });
        markChanged(context);
        context.render();
    });
    required(context.root, '[data-action="add-subevent"]').addEventListener("click", () => {
        const event = state.draft;
        if (!event) return;
        if (!event.subEvents.length && event.periods.length
            && !context.confirmLeave("Move the event’s existing time slots into the new sub-event?")) return;
        const subEvent = /** @type {SubEvent} */ ({
            subEventId: uid(),
            name: "New sub-event",
            type: SUB_EVENT_TYPES[0],
            teamIds: event.useTeams ? event.teams.map((team) => team.teamId) : [],
            periods: event.subEvents.length ? [] : event.periods,
            games: [],
        });
        subEvent.games = exampleGames(event, subEvent);
        event.subEvents.push(subEvent);
        event.periods = [];
        markChanged(context);
        context.render();
    });
}

/** @param {AdminContext} context */
export function bindEditorActions(context) {
    const { dom, state } = context;
    dom.eventName.addEventListener("input", () => {
        if (!state.draft || state.busy) return;
        state.draft.name = dom.eventName.value;
        markChanged(context);
    });
    dom.timezone.addEventListener("input", () => {
        if (!state.draft || state.busy) return;
        state.draft.timezone = dom.timezone.value;
        markChanged(context);
    });
    dom.timezone.addEventListener("change", () => {
        if (!state.draft) return;
        try {
            new Intl.DateTimeFormat("en", { timeZone: state.draft.timezone }).format();
            context.calendar?.render();
        } catch {
            showStatus(context, "Choose a valid timezone, such as Australia/Perth.", true);
        }
    });
    dom.useTeams.addEventListener("change", () => switchTeamMode(context, dom.useTeams.checked));
    dom.save.addEventListener("click", async () => {
        if (state.busy || !state.draft) return;
        const event = state.draft;
        let problem = !event.name.trim() ? "Give your event a name before saving." : "";
        if (!problem) {
            try {
                new Intl.DateTimeFormat("en", { timeZone: event.timezone }).format();
            } catch {
                problem = "Choose a valid timezone, such as Australia/Perth.";
            }
        }
        const ids = new Set();
        for (const roster of event.useTeams ? event.teams : [{ name: "Individual players", players: event.players }]) {
            if (problem) break;
            if (!roster.name.trim()) {
                problem = "Give each team a name before saving.";
                break;
            }
            for (const player of roster.players) {
                const memberId = player.memberId.trim();
                if (!player.name.trim() || !memberId) {
                    problem = "Each player needs a name and membership ID. Remove any unused rows.";
                    break;
                }
                if (ids.has(memberId)) {
                    problem = "A membership ID appears more than once in this event. Register each player once.";
                    break;
                }
                ids.add(memberId);
            }
        }
        if (!problem && event.subEvents.some((subEvent) => !subEvent.name.trim())) {
            problem = "Give each sub-event a name before saving.";
        }
        if (problem) {
            showStatus(context, problem, true);
            return;
        }
        await perform(context, "Saving event…", async () => {
            const creating = state.revision === null;
            const submitted = editableEvent(event);
            const response = await context.api.saveEvent(submitted, state.revision);
            const view = state.view;
            adopt(context, response.event, submitted.eventId);
            state.view = view;
            state.events = [...state.events.filter((item) => item.eventId !== response.event.eventId), response.event];
            if (creating) {
                if (typeof response.organiserPassword !== "string" || !response.organiserPassword
                    || response.organiserPassword.length > 1024
                    || /[\u0000-\u001f\u007f]/.test(response.organiserPassword)) {
                    throw new Error("The event was created, but its organiser password could not be displayed. Retrieve it from Parameter Store before leaving this draft.");
                }
                state.organiserCredential = {
                    eventId: response.event.eventId,
                    eventName: response.event.name,
                    password: response.organiserPassword,
                };
            }
            state.status = creating
                ? "Event created. Copy its organiser password now."
                : "Event saved. Your changes are now available to viewers.";
            state.error = false;
            state.conflict = false;
            playRandomLogoDance(context.dom.logo);
        });
    });
}
