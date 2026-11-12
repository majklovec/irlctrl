/** Log wording of the moblink_streamer module's methods (the backend registers it). */
import { type LogWording, wording } from "../../../shared/log_messages";

const log: LogWording = {
	methods: {
		"moblink_streamer.options": wording(
			"Relay tunnels",
			"Options update",
			"mlog.done.generic",
		),
	},
	sections: {
		"Relay tunnels": "Relay tunnels",
		Tunnel: "Tunnel",
		Uplink: "Uplink",
	},
	labels: {
		"Relay tunnels": "dev.card.moblink_streamer",
		Tunnel: "dev.mstream.tunnel",
		Uplink: "dev.mstream.uplink",
	},
};

export default log;
