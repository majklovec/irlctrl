/** Log wording of the moblink_relay module's methods (the backend registers it). */
import { type LogWording, wording } from "../../../shared/log_messages";

const log: LogWording = {
	methods: {
		"moblink_relay.start": wording("Relay", "Start", "mlog.done.started"),
		"moblink_relay.stop": wording("Relay", "Stop", "mlog.done.stopped"),
		"moblink_relay.reload": wording("Relay", "Reload", "mlog.done.reloaded"),
		"moblink_relay.options": wording(
			"Relay",
			"Options update",
			"mlog.done.generic",
		),
	},
	sections: {
		Relay: "Relay",
		Tunnel: "Tunnel",
		Uplink: "Uplink",
	},
	labels: {
		Relay: "dev.card.moblink_relay",
		Tunnel: "dev.moblink.tunnel",
		Uplink: "dev.moblink.uplink",
	},
};

export default log;
