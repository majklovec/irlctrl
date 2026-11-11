/**
 * MobLink streamer device module (encoder side). All of the streamer's UI —
 * the discovered relays' shared interfaces, the active TUNs, per-tunnel stats
 * and uplink state — is merged into the Network card (see
 * `../network/frontend.tsx`), so this module renders no card of its own: it
 * only keeps the device-cards registration and log wording. The module runs
 * permanently (no start/stop controls); TUN / base-IP / MTU settings stay on
 * the Settings tab (`settings.tsx`), wired via the build-time settings
 * manifest, independent of this card.
 */
import m from "mithril";
import type { FrontendModule } from "../../../shared/contracts/frontend_module";
import log from "./log";

const moblinkStreamerModule: FrontendModule = {
    id: "moblink_streamer",
    kind: "device-card",
    title: "Relay tunnels",
    order: 52,
    log,
    available: (status) => status.role === "encoder",
    // No card of its own — everything it used to show now lives in the
    // Network card's tunnel rows.
    component: () => m(""),
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
};

export default moblinkStreamerModule;
