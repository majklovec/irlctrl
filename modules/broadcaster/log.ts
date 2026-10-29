/** Log wording of the broadcaster module's methods (start / stop the
 * srtla_rec + gstreamer stream). */
import { type LogWording, wording } from "../../shared/logMessages";

const log: LogWording = {
	methods: {
		start: wording("Stream", "Start", "mlog.done.started"),
		stop: wording("Stream", "Stop", "mlog.done.stopped"),
	},
	sections: { stream: "Stream" },
	labels: { Stream: "set.broadcaster" },
};

export default log;
