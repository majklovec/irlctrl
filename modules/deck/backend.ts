/*
 * Buttons widget backend — registers the `deck` fleet dashboard widget (a
 * virtual StreamDeck, offered once per dashboard, driving any of the user's
 * devices) and validates its config on the control server. It has no device
 * lifecycle and no RPC methods of its own: a button fires another module's
 * method on the device it names, picked from the action catalogue the
 * control server merges into that device's cached status (`status.actions`).
 */
import type { ModuleWidget } from "../../shared/module-contract";
import {
    buttonDevices,
    DECK_DEFAULT_SIZE,
    DECK_FIELD,
    DECK_WIDGET_TYPE,
    orphanedButtons,
    parseButtons,
} from "./types";

const deckWidget: ModuleWidget = {
    type: DECK_WIDGET_TYPE,
    fleet: true,
    defaultSize: DECK_DEFAULT_SIZE,
    configFields: [{ name: DECK_FIELD, type: "hidden" }],
    validateConfig(config, { strict, deviceStatus, ownsDevice, deviceExists }) {
        const deck = parseButtons(config[DECK_FIELD]);
        // Another user's device is never accepted. Strict (creating the
        // dashboard) also rejects devices that are gone and actions a device
        // does not offer (its catalogue is known once it reported a status); a
        // later save keeps those buttons — the widget shows them as
        // unavailable — so a pruned device or a disabled module cannot brick
        // the dashboard.
        const foreign = buttonDevices(deck).filter(
            (id) => !ownsDevice(id) && (strict || deviceExists(id)),
        );
        if (foreign.length)
            throw new Error(`Device not available: ${foreign.join(", ")}`);
        if (!strict) return;
        const orphans = orphanedButtons(
            deck,
            (id) => deviceStatus(id)?.actions,
        );
        if (orphans.length)
            throw new Error(
                `Unknown dashboard action: ${orphans.map((b) => `${b.deviceId}/${b.actionId}`).join(", ")}`,
            );
    },
};

export default {
    id: "deck",
    kind: "widget" as const,
    title: "Buttons",
    dashboardWidgets: [deckWidget],
};
