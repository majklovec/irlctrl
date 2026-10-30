/** Log wording of the broadcaster module's methods (start / stop the
 * srtla_rec + ffmpeg stream). */
import { type LogWording, wording } from "../../shared/logMessages";

const log: LogWording = {
	methods: {
		"broadcaster.start": wording("Stream", "Start", "mlog.done.started"),
		"broadcaster.stop": wording("Stream", "Stop", "mlog.done.stopped"),
	},
	sections: { stream: "Stream" },
	labels: { Stream: "set.broadcaster" },
};

export default log;
