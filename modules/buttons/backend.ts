/*
 * Buttons widget backend — registers the `buttons` fleet dashboard widget (a
 * virtual StreamDeck, offered once per dashboard, driving any of the user's
 * devices) and validates its config on the control server. It has no device
 * lifecycle and no RPC methods of its own: a button fires another module's
 * method on the device it names, picked from the action catalogue the
 * control server merges into that device's cached status (`status.actions`).
 */
import type { ModuleWidget } from "../../shared/module-contract";
import {
	BUTTONS_DEFAULT_SIZE,
	BUTTONS_FIELD,
	BUTTONS_WIDGET_TYPE,
	buttonDevices,
	orphanedButtons,
	parseButtons,
} from "./types";

const buttonsWidget: ModuleWidget = {
	type: BUTTONS_WIDGET_TYPE,
	fleet: true,
	defaultSize: BUTTONS_DEFAULT_SIZE,
	configFields: [{ name: BUTTONS_FIELD, type: "hidden" }],
	validateConfig(
		config,
		{ strict, deviceStatus, ownsDevice, deviceExists },
	) {
		const buttons = parseButtons(config[BUTTONS_FIELD]);
		// Another user's device is never accepted. Strict (creating the
		// dashboard) also rejects devices that are gone and actions a device
		// does not offer (its catalogue is known once it reported a status); a
		// later save keeps those buttons — the widget shows them as
		// unavailable — so a pruned device or a disabled module cannot brick
		// the dashboard.
		const foreign = buttonDevices(buttons).filter(
			(id) => !ownsDevice(id) && (strict || deviceExists(id)),
		);
		if (foreign.length)
			throw new Error(`Device not available: ${foreign.join(", ")}`);
		if (!strict) return;
		const orphans = orphanedButtons(buttons, (id) => deviceStatus(id)?.actions);
		if (orphans.length)
			throw new Error(
				`Unknown dashboard action: ${orphans.map((b) => `${b.deviceId}/${b.actionId}`).join(", ")}`,
			);
	},
};

export default {
	id: "buttons",
	kind: "widget" as const,
	title: "Buttons",
	dashboardWidgets: [buttonsWidget],
};
