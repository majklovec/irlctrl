/** Log wording of the modems module's methods (bonding selection, routing, ModemManager actions). */
import {
	type LogWording,
	logTranslate,
	wording,
} from "../../shared/logMessages";

const modemAction = (action: string, key: string) =>
	wording("Modems", action, (p) => logTranslate(key, { index: p.index }));

const log: LogWording = {
	methods: {
		"modems.select": wording(
			"Interfaces",
			"Bond selection",
			"mlog.done.bond_updated",
		),
		"modems.toggle": wording("Interfaces", "Bond toggle", (p) =>
			logTranslate("mlog.done.bond_toggled", { iface: p.iface }),
		),
		reconfigure: wording("Interfaces", "Reconfigure", "mlog.done.reconfigured"),
		"modems.enable": modemAction("Enable", "mlog.done.modem_enabled"),
		"modems.disable": modemAction("Disable", "mlog.done.modem_disabled"),
		"modems.connect": modemAction("Connect", "mlog.done.modem_connected"),
		"modems.disconnect": modemAction(
			"Disconnect",
			"mlog.done.modem_disconnected",
		),
		"modems.reset": modemAction("Reset", "mlog.done.modem_reset"),
	},
	sections: { modems: "Modems", interfaces: "Interfaces" },
	labels: {
		Modems: "dev.card.modems",
		Interfaces: "dev.card.interfaces",
		"Bond selection": "mlog.action.bond_selection",
		"Bond toggle": "mlog.action.bond_toggle",
	},
};

export default log;
