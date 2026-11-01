/** @jsx m */
import m from "mithril";
import { t } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";

export type BadgeKind = "on" | "off" | "warn" | "";

export const Badge = {
	view: ({ attrs: { text, label = "", kind = "" } }) => (
		<span class={`badge ${kind}`.trim()} title={label || undefined}>
			{text}
		</span>
	),
} as MithrilJSXComponent<{ text: string; label?: string; kind?: BadgeKind }>;

/** "connected" / "disconnected" header badge. */
export const ConnectionBadge = {
	view: ({ attrs: { connected } }) =>
		connected ? (
			<Badge text={t("dev.connected")} kind="on" />
		) : (
			<Badge text={t("dev.disconnected")} kind="off" />
		),
} as MithrilJSXComponent<{ connected: boolean }>;
