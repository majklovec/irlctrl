/* Cross-module capability contracts.
 *
 * Every name here is a capability registered on the module capability bus
 * (see `shared/capabilities.ts`). Modules never import each other — the
 * consumer resolves the named capability at bind time and codes against
 * this contract, so producers and consumers stay decoupled. */

/** A ModemManager modem with the details the device panels display. */
export interface Modem {
	index: number;
	path: string;
	state: string;
	powerState: string;
	signalQuality?: number;
	accessTech?: string;
	operatorName?: string;
	registrationState?: string;
	model?: string;
	manufacturer?: string;
	imei?: string;
	primaryPort?: string;
	deviceId?: string;
	simPath?: string;
	/** Carrier IPv4 gateway (from the active bearer). Cellular gateways never
	 * appear in the main routing table, so the network module needs this to
	 * build a working per-uplink default route. */
	gateway?: string;
}

/** The `modems.source` capability (modems module): enumerate modems and
 * resolve the network interface each one currently sits on (its bonding
 * alias), so the network module can enrich its interface list. */
export interface ModemSource {
	detect(): Promise<Modem[]>;
	modemIface(modem: Modem): Promise<string | null>;
}

/** The `network.uplinks` capability (network module): the bond source-IP
 * file the bonding consumers (relay, encoder) point `srtla_send` at, plus
 * change notification so they can reload when the bond changes. */
export interface Uplinks {
	/** The uplinks file path the consumers point their `srtla_send` at. */
	file(): string;
	/** Create the uplinks file when it is missing; a no-op otherwise. */
	ensure(): Promise<void>;
	/** Register an uplinks-changed handler; returns the unsubscribe. */
	onChanged(handler: () => Promise<void>): () => void;
}
