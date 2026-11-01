/** @jsx m */
/*
 * combined module (browser half): no card — the relay and encoder cards
 * serve the role — only the role's pictogram.
 */
import m from "mithril";
import type { ContributionsModule } from "../../../shared/contracts/frontend_module";
import { OutlineIcon } from "../../../shared/ui/components/icons";

const combinedModule: ContributionsModule = {
	id: "combined",
	kind: "contributions",
	roleIcons: {
		combined: () => (
			<OutlineIcon class="role-icon role-icon-combined">
			<circle cx="12" cy="12" r="9" />
			<path d="M12 3v18M3 12h18" />
			</OutlineIcon>
		),
	},
};

export default combinedModule;
