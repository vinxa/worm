// @ts-check

/** @param {ParentNode} parent @param {string} selector @returns {HTMLElement} */
export function required(parent, selector) {
    const node = parent.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error("Missing event-admin element: " + selector);
    return node;
}

/**
 * @param {ParentNode} parent
 * @param {string} selector
 * @returns {HTMLInputElement | HTMLSelectElement}
 */
export function requiredControl(parent, selector) {
    const node = required(parent, selector);
    if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLSelectElement)) {
        throw new Error("Event-admin element is not a form control: " + selector);
    }
    return node;
}

/** @param {ParentNode} parent @param {string} selector @param {string} value */
export function setText(parent, selector, value) {
    required(parent, selector).textContent = value;
}

/** @param {HTMLElement} root @param {string} name @returns {HTMLElement} */
export function cloneTemplate(root, name) {
    const template = required(root, '[data-template="' + name + '"]');
    if (!(template instanceof HTMLTemplateElement)) throw new Error("Event-admin template is not a template: " + name);
    const node = template.content.firstElementChild?.cloneNode(true);
    if (!(node instanceof HTMLElement)) throw new Error("Event-admin template is empty: " + name);
    return node;
}

/** @param {HTMLElement} root */
export function collectAdminDom(root) {
    const timezone = requiredControl(root, '[data-field="timezone"]');
    if (!(timezone instanceof HTMLSelectElement)) {
        throw new Error("Event-admin timezone control is not a select");
    }
    return {
        logo: required(root, ".admin-brand-logo"),
        status: required(root, "[data-status-message]"),
        reload: required(root, '[data-action="reload-event"]'),
        lock: required(root, '[data-action="lock"]'),
        authSetup: required(root, "[data-auth-setup]"),
        authForm: required(root, "[data-auth-form]"),
        authTitle: required(root, "[data-auth-title]"),
        password: requiredControl(root, '[data-field="password"]'),
        eventList: required(root, "[data-event-list]"),
        eventEmpty: required(root, "[data-event-empty]"),
        create: required(root, '[data-action="create-event"]'),
        organiserCredential: required(root, "[data-organiser-credential]"),
        organiserEventName: required(root, "[data-organiser-event-name]"),
        organiserPassword: /** @type {HTMLInputElement} */ (requiredControl(root, '[data-field="organiser-password"]')),
        copyOrganiserPassword: required(root, '[data-action="copy-organiser-password"]'),
        hideOrganiserPassword: required(root, '[data-action="hide-organiser-password"]'),
        back: required(root, '[data-action="back"]'),
        draftTitle: required(root, "[data-draft-title]"),
        draftContext: required(root, "[data-draft-context]"),
        dirty: required(root, "[data-dirty]"),
        save: required(root, "[data-save]"),
        eventName: requiredControl(root, '[data-field="event-name"]'),
        timezone,
        useTeams: /** @type {HTMLInputElement} */ (requiredControl(root, '[data-field="use-teams"]')),
        teamsLinkTitle: required(root, "[data-teams-link-title]"),
        teamsLinkCopy: required(root, "[data-teams-link-copy]"),
        subeventsLinkCopy: required(root, "[data-subevents-link-copy]"),
        calendarHost: required(root, "[data-calendar]"),
        individualRoster: required(root, "[data-individual-roster]"),
        individualPlayers: required(root, "[data-individual-players]"),
        teamListHeading: required(root, "[data-team-list-heading]"),
        teamCount: required(root, "[data-team-count]"),
        teamList: required(root, "[data-team-list]"),
        teamEmpty: required(root, "[data-team-empty]"),
        subeventList: required(root, "[data-subevent-list]"),
        subeventEmpty: required(root, "[data-subevent-empty]"),
        views: new Map([.../** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-view]"))]
            .map((node) => [node.dataset.view, node])),
        editorSections: new Map([.../** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-editor-section]"))]
            .map((node) => [node.dataset.editorSection, node])),
    };
}
