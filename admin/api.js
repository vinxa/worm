// @ts-check

export class EventAdminError extends Error {
    /** @param {string} message @param {number} status */
    constructor(message, status = 0) {
        super(message);
        this.status = status;
    }
}

/**
 * The password lives only in this closure, never in storage or a URL.
 *
 * @param {{url?: string, fetcher?: typeof fetch, onUnauthorized?: () => void}} options
 */
export function createEventAdminApi({ url, fetcher = (...args) => fetch(...args), onUnauthorized = () => {} }) {
    let credential = "";
    const baseUrl = String(url || "").replace(/\/+$/, "");
    let validUrl = false;
    try {
        const parsed = new URL(baseUrl);
        validUrl = parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch { /* A missing deployment setting is handled before making a request. */ }
    /** @param {string} path @param {{method?: string, body?: object, password?: string}} options */
    async function request(path, { method = "GET", body, password = credential } = {}) {
        if (!validUrl) throw new EventAdminError("The event editor has not been connected securely yet. Ask your WORM administrator to finish setup.");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await Promise.resolve().then(() => fetcher(`${baseUrl}${path}`, {
                    method,
                    headers: { ...(password ? { Authorization: `Bearer ${password}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                    cache: "no-store",
                    signal: controller.signal,
                })).catch(() => { throw new EventAdminError("We couldn’t reach the event service. Your draft is still here; try again."); });
            if (response.status === 401 || response.status === 403) {
                credential = "";
                onUnauthorized();
                throw new EventAdminError("Please sign in again to continue. Your draft is still here.", response.status);
            }
            if (response.status === 409) {
                throw new EventAdminError("Someone else saved this event. Your draft is still here. Reload the saved event before replacing its changes.", 409);
            }
            const result = await Promise.resolve().then(() => response.json())
                .catch(() => { throw new EventAdminError("The event service returned an unreadable response. Your draft is still here."); });
            if (!response.ok || result?.ok !== true) {
                const detail = Array.isArray(result?.errors) ? result.errors.join(" ") : "Please check your event details and try again.";
                throw new EventAdminError(detail, response.status);
            }
            return result;
        } finally { clearTimeout(timeout); }
    }
    return {
        /** @param {string} password */
        async authenticate(password) {
            const result = await request("/auth", { method: "POST", password });
            credential = password;
            return result;
        },
        listEvents: () => request("/events"),
        /** @param {string} eventId */
        getEvent: (eventId) => request(`/events/${encodeURIComponent(eventId)}`),
        /** @param {{eventId: string}} event @param {string | null} expectedRevision */
        saveEvent: (event, expectedRevision) => request(`/events/${encodeURIComponent(event.eventId)}`, {
            method: "PUT", body: { event, expectedRevision },
        }),
        lock() { credential = ""; },
    };
}
