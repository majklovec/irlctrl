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
	/** Current band mode from `modem.generic.current-modes`. `allowed` is empty
	 * when the modem is in auto mode (no fixed band). Set for `mm` modems. */
	currentModes?: { allowed: string[]; preferred: string[] };
	/** The RATs the modem supports, from `modem.generic.supported-modes`. */
	supportedModes?: string[];
	/** The exact (allowed, preferred) RAT combinations the modem accepts,
	 * each as a bitmask over generation order (bit 0 = 2G/GSM, 1 = 3G/UMTS,
	 * 2 = 4G/LTE, 3 = 5G/NR) — mmcli only sets combinations from this list.
	 * Empty/absent = MM reported none (requests are sent as-is). */
	supportedCombinations?: { allowed: number; preferred: number }[];
	/** Carrier IPv4 gateway (from the active bearer). Cellular gateways never
	 * appear in the main routing table, so the network module needs this to
	 * build a working per-uplink default route. */
	gateway?: string;
}

/** A PLMN seen by a 3GPP network scan (`modems.scan`). */
export interface ScannedNetwork {
	/** The PLMN as reported by the scan, dotted "MCC,MNC" (e.g. "505,01"). */
	plmn: string;
	/** MCC + MNC as contiguous digits (e.g. "50501") — the form ModemManager's
	 * RegisterToOperator (`mmcli --3gpp-register-in-operator`) expects. */
	plmnId: string;
	/** The modem's registration state for this PLMN: current / available / forbidden. */
	status: string;
	/** The radio access technology the scan saw for this PLMN (gsm / umts / lte / nr5g). */
	accessTech?: string;
	operatorName?: string;
}

/** The `modems.source` capability (modems module): enumerate modems and
 * resolve the network interface each one currently sits on (its bonding
 * alias), so the network module can enrich its interface list. */
export interface ModemSource {
	detect(): Promise<Modem[]>;
	modemIface(modem: Modem): Promise<string | null>;
}

/** The `network.interfaces` capability (network module): enumerate the
 * machine's IPv4 interfaces and observe changes, so per-interface consumers
 * (moblink-relay) keep their per-interface state in sync with the OS. */
export interface NetworkInterfaces {
	/** Every non-loopback interface with at least one IPv4 address. */
	list(): Array<{ name: string; addresses: string[] }>;
	/** Register an interface-set change handler; returns the unsubscribe. */
	onChanged(handler: () => void): () => void;
	/**
	 * Start the live interface monitor if it is not already running (e.g. when
	 * the network module's slice is disabled on this role); no-op otherwise.
	 */
	ensureMonitoring(): Promise<void>;
}

/** A tunnel interface a MobLink relay offers (see shared/moblink_discovery). */
export interface MoblinkSharedEndpoint {
	/** The relay-side TUN name. */
	name: string;
	/** The relay LAN address the UDP relay binds to. */
	address: string;
	/** The UDP relay port for this interface. */
	listenPort: number;
}

/** A relay the encoder has learned about (via UDP announce). */
export interface MoblinkDiscoveredRelay {
	/** The relay's primary LAN address (stable identity; the registry key). */
	host: string;
	hostname?: string;
	interfaces: MoblinkSharedEndpoint[];
	/** Epoch ms we last heard from this relay (shown as "last discovered"). */
	lastSeen?: number;
	/**
	 * `true` while the relay's control-channel WebSocket is open (protocol.md
	 * §3: the relay dials the encoder's WS server). The network card renders a
	 * green dot next to the relay name when this is set — a live WS is a
	 * stronger "reachable" signal than a TTL'd UDP announce.
	 */
	wsConnected?: boolean;
}

/** The `network.moblink` capability (network module): the small registry of
 * relays the encoder has learned about, surfaced on the network card's
 * interface list grouped per-relay. The encoder's `moblink_streamer` module
 * writes to it as relays discover themselves (UDP announce); the network card
 * reads it to render the grouped "shared interfaces" sections. */
export interface MoblinkRegistry {
	/** Upsert a relay entry (by host). */
	upsertRelay(relay: MoblinkDiscoveredRelay): void;
	/** Drop a relay that is no longer heard. */
	dropRelay(host: string): void;
	/** The currently-registered relays. */
	listRelays(): MoblinkDiscoveredRelay[];
}

/** A programmatically registered uplink (e.g. a Moblink TUN interface IP). */
export interface UplinkEntry {
	/** Stable unique id (e.g. `moblink:moblink0`). */
	id: string;
	/** The source IP to add to the uplinks file. */
	source: string;
	/** Human label for status panels (optional). */
	label?: string;
}

/** The `network.uplinks` capability (network module): the bond source-IP
 * file the bonding consumers (relay, encoder) point `srtla_send` at, plus
 * change notification so they can reload when the bond changes.
 *
 * `add`/`remove`/`list` expose programmatic uplinks: an entry is merged into
 * the uplinks file alongside the detected bond IPs (deduplicated, extras
 * last) and `onChanged` handlers fire when the file changes. `source` must
 * be a valid IPv4 literal — `add` rejects anything else. */
export interface Uplinks {
	/** The uplinks file path the consumers point their `srtla_send` at. */
	file(): string;
	/** Create the uplinks file when it is missing; a no-op otherwise. */
	ensure(): Promise<void>;
	/** Register an uplinks-changed handler; returns the unsubscribe. */
	onChanged(handler: () => Promise<void>): () => void;
	/** Add (or replace, by id) a programmatic uplink; rejects bad sources. */
	add(entry: UplinkEntry): Promise<void>;
	/** Remove a programmatic uplink by id; no-op when the id is unknown. */
	remove(id: string): Promise<void>;
	/** The currently registered programmatic uplinks. */
	list(): UplinkEntry[];
}
