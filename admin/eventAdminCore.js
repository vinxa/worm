// @ts-check

import { editableEvent, playerCount, uid } from "./eventEditorModel.js";
import { validateEventCatalog } from "../scripts/eventCatalog.js";

/**
 * @typedef {import("./eventAdminContext.js").AdminContext} AdminContext
 * @typedef {import("./eventAdminContext.js").AdminView} AdminView
 * @typedef {import("./eventEditorModel.js").EventRecord} EventRecord
 */

/** @param {AdminContext} context */
export function updateStatus(context) {
    const { state, dom, root } = context;
    dom.dirty.textContent = state.dirty ? "● Unsaved changes" : "All changes saved";
    root.querySelectorAll("button").forEach((node) => {
        node.disabled = state.busy || (node.hasAttribute("data-save") && !state.dirty);
    });
    /** @type {NodeListOf<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */
    (root.querySelectorAll("input, select, textarea")).forEach((node) => { node.disabled = state.busy; });
    dom.calendarHost.inert = state.busy;
    dom.status.hidden = !state.status;
    dom.status.textContent = state.status;
    dom.status.classList.toggle("admin-status--error", state.error);
    dom.reload.hidden = !(state.conflict && state.draft);
}

/** @param {AdminContext} context @param {string} message @param {boolean} error */
export function showStatus(context, message, error = false) {
    context.state.status = message;
    context.state.error = error;
    updateStatus(context);
}

/** @param {AdminContext} context @param {string} message @param {() => Promise<void>} action */
export async function perform(context, message, action) {
    if (context.state.busy) return;
    context.state.busy = true;
    context.state.conflict = false;
    showStatus(context, message);
    try {
        await action();
    } catch (reason) {
        const error = reason instanceof Error ? reason : new Error("The event editor encountered an unexpected error.");
        context.state.status = error.message;
        context.state.error = true;
        context.state.conflict = "status" in error && error.status === 409;
    } finally {
        context.state.busy = false;
        context.render();
    }
}

/** @param {AdminContext} context */
export function canDiscard(context) {
    return !context.state.dirty || context.confirmLeave("Leave this draft and discard its unsaved changes?");
}

/** @param {AdminContext} context @param {Exclude<AdminView, "list">} view */
export function openSection(context, view) {
    context.state.view = view;
    context.state.status = "";
    context.render();
    window.scrollTo(0, 0);
}

/** @param {AdminContext} context */
export function markChanged(context) {
    context.state.dirty = true;
    context.state.status = "";
    context.state.conflict = false;
    updateStatus(context);
    if (context.state.view === "event" && context.state.draft) {
        context.dom.draftTitle.textContent = context.state.draft.name || "Untitled event";
    }
}

/** @param {AdminContext} context @param {unknown} event @param {string} expectedId */
export function adopt(context, event, expectedId) {
    if (!event || typeof event !== "object" || !("eventId" in event) || event.eventId !== expectedId) {
        throw new Error("The event service returned a different event. Your current draft has been kept.");
    }
    let validEvent;
    try {
        [validEvent] = /** @type {EventRecord[]} */ (validateEventCatalog({ ok: true, events: [event] }));
    } catch {
        throw new Error("The saved event couldn’t be read. Your current draft has been kept.");
    }
    context.state.draft = editableEvent(validEvent);
    context.state.revision = validEvent.revision ?? null;
    context.state.dirty = false;
    context.state.view = "event";
}

/** @param {unknown} payload @returns {EventRecord[]} */
export function readEvents(payload) {
    try {
        return /** @type {EventRecord[]} */ (validateEventCatalog(payload));
    } catch {
        throw new Error("The event list couldn’t be read. Please try again.");
    }
}

/** @param {AdminContext} context @param {string} eventId */
export async function openEvent(context, eventId) {
    if (context.state.busy || !canDiscard(context)) return;
    await perform(context, "Opening event…", async () => {
        adopt(context, (await context.api.getEvent(eventId)).event, eventId);
        context.state.organiserCredential = null;
        context.state.status = "";
    });
}

/** @param {AdminContext} context */
export function refreshExamples(context) {
    const event = context.state.draft;
    if (!event) return;
    const validTeamIds = new Set(event.teams.map((team) => team.teamId));
    const validMemberIds = new Set(event.players.map((player) => player.memberId.trim()));
    event.subEvents.forEach((subEvent) => {
        subEvent.teamIds = event.useTeams
            ? (Array.isArray(subEvent.teamIds) ? subEvent.teamIds : [...validTeamIds])
                .filter((teamId) => validTeamIds.has(teamId))
            : [];
        const allocatedTeamIds = new Set(subEvent.teamIds);
        subEvent.games = subEvent.games.filter((game) => event.useTeams
            ? game.teamIds.every((id) => allocatedTeamIds.has(id)) && !game.memberIds.length
            : game.memberIds.every((id) => validMemberIds.has(id)) && !game.teamIds.length);
    });
}

/** @param {AdminContext} context @param {boolean} useTeams */
export function switchTeamMode(context, useTeams) {
    const event = context.state.draft;
    if (!event || useTeams === event.useTeams) return;
    const message = useTeams
        ? "Move individual players into a new team? Sample matches will be cleared."
        : "Move team players into the individual roster? Team names and sample matches will be removed.";
    if ((playerCount(event) || event.teams.length || event.subEvents.some((subEvent) => subEvent.games.length))
        && !context.confirmLeave(message)) {
        context.render();
        return;
    }
    if (useTeams) {
        event.teams = event.players.length ? [{ teamId: uid(), name: "New team", players: event.players }] : [];
        event.players = [];
    } else {
        const seen = new Set();
        event.players = event.teams.flatMap((team) => team.players).filter((player) => {
            if (player.memberId.trim() && seen.has(player.memberId.trim())) return false;
            if (player.memberId.trim()) seen.add(player.memberId.trim());
            return true;
        });
        event.teams = [];
    }
    event.useTeams = useTeams;
    event.subEvents.forEach((subEvent) => {
        subEvent.teamIds = useTeams ? event.teams.map((team) => team.teamId) : [];
        subEvent.games = [];
    });
    markChanged(context);
    context.render();
}
