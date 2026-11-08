/* Types for the modems module. The modem shape and the `modems.source`
 * capability contract live in shared/ (the network module codes against
 * the same contract); `ModemInfo` is the module-internal alias. */

import type { Modem } from "../../../shared/contracts/module_capabilities";

export type { ModemSource } from "../../../shared/contracts/module_capabilities";

/** A ModemManager modem with the details the panels display. */
export type ModemInfo = Modem;

/** The modems module's status fragment (deep-merged into the device status). */
export interface ModemsStatus {
    modems: ModemInfo[];
}
