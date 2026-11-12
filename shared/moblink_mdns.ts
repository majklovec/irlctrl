/*
 * MobLink mDNS discovery (zero-dependency, `node:dgram` + minimal DNS wire
 * format). Third discovery path alongside UDP broadcast + control server
 * (TODO/protocol.md §3): each box advertises itself as an mDNS-SD service
 * and every peer browses for the opposite service type.
 *
 * Services (port 5353 multicast `224.0.0.251`):
 *   `_irlctrl-relay._udp.local`   — relay → encoders
 *       TXT: `h=<hostname>;ip=<primary>;i=<name=addr:port;name2=addr2:port2>`
 *   `_irlctrl-encoder._udp.local` — encoder → relays
 *       TXT: `id=<encoderId>;ip=<ip>;port=<wsPort>;proto=<proto>[;tok=<token>]`
 *       SRV port = the encoder's WS port (the dialable service).
 *
 * The payload is compact (TXT ceiling: 255 bytes); the authoritative full
 * snapshot still flows over the WS `hello`. The advertiser re-broadcasts its
 * record every `MDNS_REFRESH_MS` and answers PTR/SRV/TXT queries; the browser
 * re-queries on the same cadence (mDNS is pull-based — the 15 s registry
 * TTLs stay fresh while the box is up). `udpPort` is parameterized so tests
 * can run on a scratch port and coexist with a real 5353.
 */
import dgram from "node:dgram";

export const MDNS_ADDR = "224.0.0.251";
export const MDNS_PORT_DEFAULT = 5_353;
export const MDNS_RELAY_SERVICE = "_irlctrl-relay._udp.local";
export const MDNS_ENCODER_SERVICE = "_irlctrl-encoder._udp.local";
/** Re-advertise / re-query cadence (well under the 15 s registry TTL). */
export const MDNS_REFRESH_MS = 10_000;
/** TXT record data ceiling (DNS). */
export const MDNS_TXT_MAX_BYTES = 255;

// ----------------------------------------------------------------------
// DNS wire format (just enough for PTR / SRV / TXT)
// ----------------------------------------------------------------------
const T_PTR = 12;
const T_SRV = 33;
const T_TXT = 16;

/** Encode a DNS name (labels); unsafe chars are mangled, labels capped. */
export function encodeName(name: string): Buffer {
	const chunks: Buffer[] = [];
	for (const raw of name.split(".")) {
		const label = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 63) || "-";
		chunks.push(Buffer.from([label.length]), Buffer.from(label, "ascii"));
	}
	chunks.push(Buffer.from([0]));
	return Buffer.concat(chunks);
}

/** Decode a (possibly compression-pointer) DNS name; returns [name, end]. */
function nameAt(buf: Buffer, offset: number): [string, number] {
	const labels: string[] = [];
	let pos = offset;
	let hops = 0;
	for (;;) {
		if (pos >= buf.length || ++hops > 16) return [labels.join("."), pos];
		const len = buf[pos];
		if (len === 0) {
			pos += 1;
			break;
		}
		if (len & 0xc0) {
			const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
			const [tail] = nameAt(buf, ptr);
			if (tail) labels.push(tail);
			return [labels.join("."), pos + 2];
		}
		labels.push(buf.subarray(pos + 1, pos + 1 + len).toString("ascii"));
		pos += 1 + len;
	}
	return [labels.join("."), pos];
}

/** A resource record parsed from a response (answer + authority). */
export interface MdnsRecord {
	name: string;
	type: number;
	rdata: Buffer;
}

/** Parse a DNS packet into its records (question section skipped). */
export function parseRecords(buf: Buffer): MdnsRecord[] {
	if (buf.length < 12) return [];
	const ancount = buf.readUInt16BE(6);
	const nscount = buf.readUInt16BE(8);
	const out: MdnsRecord[] = [];
	let pos = 12;
	const qcount = buf.readUInt16BE(4);
	for (let i = 0; i < qcount; i++) {
		[, pos] = nameAt(buf, pos);
		pos += 4;
	}
	for (let i = 0; i < ancount + nscount; i++) {
		if (pos >= buf.length - 10) break;
		const [, dataStart] = nameAt(buf, pos);
		const type = buf.readUInt16BE(dataStart);
		const rdlen = buf.readUInt16BE(dataStart + 8);
		const rdataStart = dataStart + 10;
		if (rdataStart + rdlen > buf.length) break;
		out.push({
			name: nameAt(buf, pos)[0],
			type,
			rdata: buf.subarray(rdataStart, rdataStart + rdlen),
		});
		pos = rdataStart + rdlen;
	}
	return out;
}

/** Decode an SRV rdata: priority / port / target. */
export function decodeSrv(rdata: Buffer): {
	priority: number;
	port: number;
	target: string;
} | null {
	if (rdata.length < 6) return null;
	return {
		priority: rdata.readUInt16BE(0),
		port: rdata.readUInt16BE(2),
		target: nameAt(rdata, 4)[0],
	};
}

/** Decode a TXT rdata into ordered `key → value` fields. */
export function decodeTxt(rdata: Buffer): Map<string, string> {
	const out = new Map<string, string>();
	let pos = 0;
	while (pos < rdata.length) {
		const len = rdata[pos];
		pos += 1;
		if (len === 0) continue;
		const s = rdata.subarray(pos, pos + len).toString("utf8");
		pos += len;
		const eq = s.indexOf("=");
		if (eq > 0) out.set(s.slice(0, eq), s.slice(eq + 1));
	}
	return out;
}

/** Encode TXT fields as rdata, keeping the longest prefix that fits the
 * 255-byte ceiling (order preserved; over-long fields dropped). */
export function encodeTxt(fields: string[]): Buffer {
	const chunks: Buffer[] = [];
	let size = 0;
	for (const f of fields) {
		const b = Buffer.byteLength(f, "utf8");
		if (b === 0 || b > 255) continue;
		if (size + b + 1 > MDNS_TXT_MAX_BYTES) continue;
		chunks.push(Buffer.from([b]), Buffer.from(f, "utf8"));
		size += b + 1;
	}
	return Buffer.concat(chunks);
}

/** A service instance id (hostname) as a safe first DNS label. */
export function mdnsInstanceLabel(id: string): string {
	const s = id
		.trim()
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/^[-.]+/, "")
		.slice(0, 63);
	return s || "irlctrl";
}

/** Build a standard PTR query datagram for a service type. */
export function buildPtrQuery(service: string): Buffer {
	const head = Buffer.alloc(12);
	head.writeUInt16BE(0, 0); // id
	head.writeUInt16BE(0, 2); // flags: standard query
	head.writeUInt16BE(1, 4); // qdcount
	return Buffer.concat([
		head,
		encodeName(service),
		Buffer.from([0, T_PTR, 0, 1]), // QTYPE=PTR QCLASS=IN
	]);
}

function record(name: Buffer, type: number, rd: Buffer): Buffer {
	const fixed = Buffer.alloc(10);
	fixed.writeUInt16BE(type, 0);
	fixed.writeUInt16BE(1, 2); // class IN
	fixed.writeUInt32BE(120, 4); // ttl
	fixed.writeUInt16BE(rd.length, 8);
	return Buffer.concat([name, fixed, rd]);
}

// ----------------------------------------------------------------------
// Advertiser
// ----------------------------------------------------------------------
export interface MdnsAdvertiserOptions {
	/** Instance id (e.g. the box hostname) — the DNS label. */
	instance: string;
	/** Service type (`MDNS_RELAY_SERVICE` / `MDNS_ENCODER_SERVICE`). */
	service: string;
	/** The dialable service port (SRV record). */
	servicePort: number;
	/** TXT fields to publish (re-evaluated every refresh); null = silent. */
	buildTxt: () => string[] | null;
	/** Multicast UDP port (tests use a scratch port). Default 5353. */
	udpPort?: number;
	dryRun?: boolean;
}

/**
 * Advertise `instance` under `service`: re-broadcast PTR/SRV/TXT on each
 * refresh and answer PTR queries for the service type. Best-effort — socket
 * errors log and stop it. Returns a stop function.
 */
export function startMdnsAdvertiser(opts: MdnsAdvertiserOptions): () => void {
	const udpPort = opts.udpPort ?? MDNS_PORT_DEFAULT;
	if (opts.dryRun) return () => {};
	let socket: dgram.Socket | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopped = false;
	try {
		const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
		const instanceName = `${mdnsInstanceLabel(opts.instance)}.${opts.service}`;
		const buildResponse = (): Buffer | null => {
			const txt = opts.buildTxt();
			if (!txt) return null;
			const svc = encodeName(opts.service);
			const inst = encodeName(instanceName);
			const head = Buffer.alloc(12);
			head.writeUInt16BE(0, 0);
			head.writeUInt16BE(0x8400, 2); // response + authoritative
			head.writeUInt16BE(3, 6); // ancount
			const srvHead = Buffer.alloc(4);
			srvHead.writeUInt16BE(0, 0); // priority
			srvHead.writeUInt16BE(opts.servicePort, 2);
			return Buffer.concat([
				head,
				record(svc, T_PTR, inst),
				record(inst, T_SRV, Buffer.concat([srvHead, inst])),
				record(inst, T_TXT, encodeTxt(txt)),
			]);
		};
		s.on("error", (e) => {
			console.warn(`moblink_mdns: advertiser socket error: ${e.message}`);
			stop();
		});
		// Answer PTR queries for our service type (the browser's re-query).
		s.on("message", (msg, rinfo) => {
			if (msg.length < 18) return;
			const qcount = msg.readUInt16BE(4);
			let pos = 12;
			for (let i = 0; i < qcount && pos < msg.length - 4; i++) {
				const [name, next] = nameAt(msg, pos);
				if (name === opts.service) {
					const pkt = buildResponse();
					if (pkt)
						s.send(pkt, rinfo.port, rinfo.address, (e) => {
							if (e && !stopped)
								console.warn(
									`moblink_mdns: advertiser reply failed: ${e.message}`,
								);
						});
					return;
				}
				pos = next + 4;
			}
		});
		try {
			s.setMulticastTTL(2);
			s.setMulticastLoopback(true);
		} catch {
			/* best-effort */
		}
		s.bind(udpPort, () => {
			if (stopped) return;
			try {
				s.addMembership(MDNS_ADDR);
			} catch {
				/* membership unavailable in some sandboxes */
			}
			const tick = (): void => {
				const pkt = buildResponse();
				if (!pkt) return;
				s.send(pkt, udpPort, MDNS_ADDR, (e) => {
					if (e && !stopped)
						console.warn(`moblink_mdns: advertise send failed: ${e.message}`);
				});
			};
			tick();
			timer = setInterval(tick, MDNS_REFRESH_MS);
			timer.unref?.();
			console.log(
				`moblink_mdns: advertising ${instanceName} every ${MDNS_REFRESH_MS}ms`,
			);
		});
		socket = s;
	} catch (e) {
		console.warn(`moblink_mdns: advertiser failed to start: ${String(e)}`);
	}
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		if (timer) clearInterval(timer);
		if (socket) {
			try {
				socket.close();
			} catch {
				/* already closed */
			}
		}
	};
	return stop;
}

// ----------------------------------------------------------------------
// Browser
// ----------------------------------------------------------------------
export interface MdnsFound {
	/** Full instance name: `<label>.<service>`. */
	instance: string;
	/** TXT fields of the freshest TXT record for the instance. */
	fields: Map<string, string>;
	/** SRV port for the instance, if announced. */
	srvPort?: number;
}

export interface MdnsBrowserOptions {
	service: string;
	/** Every (re)seen instance of the service (re-fires each query round). */
	onFound: (found: MdnsFound) => void;
	/** Multicast UDP port (tests use a scratch port). Default 5353. */
	udpPort?: number;
	dryRun?: boolean;
}

/**
 * Browse `service`: re-query every `MDNS_REFRESH_MS`, parse answers, and hand
 * each instance (TXT/SRV attached) to `onFound`. Best-effort. Returns a stop
 * function.
 */
export function startMdnsBrowser(opts: MdnsBrowserOptions): () => void {
	const udpPort = opts.udpPort ?? MDNS_PORT_DEFAULT;
	if (opts.dryRun) return () => {};
	let socket: dgram.Socket | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopped = false;
	try {
		const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
		s.on("error", (e) => {
			if (!stopped)
				console.warn(`moblink_mdns: browser socket error: ${e.message}`);
			stop();
		});
		s.on("message", (msg) => {
			// Instance → attached data, keyed by PTR target.
			const found = new Map<
				string,
				{ fields: Map<string, string>; srvPort?: number }
			>();
			for (const r of parseRecords(msg)) {
				if (r.type === T_PTR && r.name === opts.service) {
					const labels = decodeName(r.rdata);
					if (labels)
						found.set(labels, found.get(labels) ?? { fields: new Map() });
				} else if (r.type === T_TXT) {
					const cur = found.get(r.name);
					if (cur) cur.fields = decodeTxt(r.rdata);
				} else if (r.type === T_SRV) {
					const srv = decodeSrv(r.rdata);
					const cur = found.get(r.name);
					if (cur && srv) cur.srvPort = srv.port;
				}
			}
			for (const [instance, data] of found) {
				try {
					opts.onFound({ instance, ...data });
				} catch {
					/* a consumer error must not kill the browser */
				}
			}
		});
		try {
			s.setMulticastLoopback(true);
			s.addMembership(MDNS_ADDR);
		} catch {
			/* membership unavailable — remote hosts can still answer */
		}
		s.bind(udpPort, () => {
			if (stopped) return;
			const tick = (): void => {
				s.send(buildPtrQuery(opts.service), udpPort, MDNS_ADDR, (e) => {
					if (e && !stopped)
						console.warn(`moblink_mdns: query send failed: ${e.message}`);
				});
			};
			tick();
			timer = setInterval(tick, MDNS_REFRESH_MS);
			timer.unref?.();
			console.log(`moblink_mdns: browsing ${opts.service}`);
		});
		socket = s;
	} catch (e) {
		console.warn(`moblink_mdns: browser failed to start: ${String(e)}`);
	}
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		if (timer) clearInterval(timer);
		if (socket) {
			try {
				socket.close();
			} catch {
				/* already closed */
			}
		}
	};
	return stop;
}

/** Decode a raw (uncompressed, no pointers) resource name; null on garbage. */
function decodeName(buf: Buffer): string | null {
	const labels: string[] = [];
	let pos = 0;
	while (pos < buf.length) {
		const len = buf[pos];
		if (len === 0) return labels.join(".");
		if (len & 0xc0) return null; // pointer in a PTR target: unsupported
		if (pos + 1 + len > buf.length) return null;
		labels.push(buf.subarray(pos + 1, pos + 1 + len).toString("ascii"));
		pos += 1 + len;
	}
	return labels.length ? labels.join(".") : null;
}
