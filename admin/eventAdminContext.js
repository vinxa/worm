// @ts-check

import { EVENT_ADMIN_API_URL } from "./config.js";
import { createEventAdminApi } from "./api.js";
import { createCalendar } from "./calendar.js";
import { collectAdminDom } from "./eventAdminDom.js";

/**
 * @typedef {import("./eventEditorModel.js").EventRecord} EventRecord
 * @typedef {"list" | "event" | "teams" | "subevents"} AdminView
 * @typedef {{
 *   authenticated: boolean,
 *   role: "admin" | "organiser" | null,
 *   view: AdminView,
 *   events: EventRecord[],
 *   draft: EventRecord | null,
 *   revision: string | null,
 *   organiserCredential: {eventId: string, eventName: string, password: string} | null,
 *   dirty: boolean,
 *   busy: boolean,
 *   status: string,
 *   error: boolean,
 *   conflict: boolean
 * }} AdminState
 * @typedef {{
 *   apiUrl?: string,
 *   fetcher?: typeof fetch,
 *   confirmLeave?: (message: string) => boolean,
 *   calendarFactory?: typeof createCalendar
 * }} AdminOptions
 * @typedef {{
 *   root: HTMLElement,
 *   apiUrl: string,
 *   confirmLeave: (message: string) => boolean,
 *   calendarFactory: typeof createCalendar,
 *   initialChildren: Node[],
 *   state: AdminState,
 *   calendar: ReturnType<typeof createCalendar> | null,
 *   api: ReturnType<typeof createEventAdminApi>,
 *   dom: ReturnType<typeof collectAdminDom>,
 *   render: () => void
 * }} AdminContext
 */

/** @param {HTMLElement} root @param {AdminOptions} [options] @returns {AdminContext} */
export function createAdminContext(root, {
    apiUrl = EVENT_ADMIN_API_URL,
    fetcher = (...args) => fetch(...args),
    confirmLeave = (message) => window.confirm(message),
    calendarFactory = createCalendar,
} = {}) {
    const state = /** @type {AdminState} */ ({
        authenticated: false,
        role: null,
        view: "list",
        events: [],
        draft: null,
        revision: null,
        organiserCredential: null,
        dirty: false,
        busy: false,
        status: "",
        error: false,
        conflict: false,
    });
    const api = createEventAdminApi({
        url: apiUrl,
        fetcher,
        onUnauthorized: () => {
            state.authenticated = false;
            state.role = null;
            state.events = [];
            state.organiserCredential = null;
        },
    });
    return {
        root,
        apiUrl,
        confirmLeave,
        calendarFactory,
        initialChildren: [...root.childNodes].map((node) => node.cloneNode(true)),
        state,
        calendar: null,
        api,
        dom: collectAdminDom(root),
        render: () => {},
    };
}
