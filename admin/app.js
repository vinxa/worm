// @ts-check

import { playRandomLogoDance, setupLogoDance } from "../scripts/logoDance.js";
import { bindEditorActions, bindNavigationActions, bindSessionActions } from "./eventAdminBindings.js";
import { createAdminContext } from "./eventAdminContext.js";
import { renderAdmin } from "./eventAdminView.js";

export { SUB_EVENT_TYPES, editableEvent, exampleGames } from "./eventEditorModel.js";

/**
 * Attach the event-admin modules to the semantic HTML in admin/index.html.
 *
 * @param {HTMLElement} root
 * @param {import("./eventAdminContext.js").AdminOptions} [options]
 */
export function mountEventAdmin(root, options = {}) {
    const context = createAdminContext(root, options);
    context.render = () => renderAdmin(context);
    bindSessionActions(context);
    bindNavigationActions(context);
    bindEditorActions(context);

    const stopLogoDance = setupLogoDance(context.dom.logo, { hotkeyTarget: document });
    /** @param {BeforeUnloadEvent} event */
    const beforeUnload = (event) => {
        if (!context.state.dirty) return;
        event.preventDefault();
        event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    context.render();
    playRandomLogoDance(context.dom.logo);

    return {
        destroy() {
            context.api.lock();
            context.state.organiserCredential = null;
            context.calendar?.destroy();
            stopLogoDance();
            window.removeEventListener("beforeunload", beforeUnload);
            root.replaceChildren(...context.initialChildren.map((node) => node.cloneNode(true)));
        },
    };
}
