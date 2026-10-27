/** Log wording of the ssh module's methods (registered by both the backend and the frontend). */
import {
	type LogWording,
	logTranslate,
	wording,
} from "../../shared/logMessages";

const log: LogWording = {
	methods: {
		"ssh.start": wording("SSH", "Start", "mlog.done.started"),
		"ssh.stop": wording("SSH", "Stop", "mlog.done.stopped"),
		"ssh.reset_password": wording("SSH", "Password reset", (p) =>
			logTranslate("mlog.done.ssh_password_reset", { user: p.user }),
		),
		"ssh.set_password": wording("SSH", "Password set", (p) =>
			logTranslate("mlog.done.ssh_password_set", { user: p.user }),
		),
	},
	sections: { ssh: "SSH" },
	labels: { SSH: "dev.card.ssh" },
};

export default log;
