/*
 * OBS audio-source tracker: every input with a mute state, kept current from
 * obs-websocket events. Shared by the in-process obs-controller module and the
 * standalone obs-client box — both publish `list()` as
 * `status.obs.audioSources`, which the module's `dashboardActions` factory
 * turns into one mute toggle per source.
 */
import { randomUUID } from "node:crypto";
import { OBS_DISCONNECTED_EVENT, type ObsClient } from "../../shared/obs/client";

export interface AudioSource {
	name: string;
	muted: boolean;
}

type Data = Record<string, unknown>;

export class AudioSourceTracker {
	/** name → muted; a source is only present once its mute state is known. */
	private readonly sources = new Map<string, boolean>();
	/** Names already queried (in flight or failed — e.g. a video input with no
	 * audio): the high-rate VU-meter stream must not re-query them every tick. */
	private readonly queried = new Set<string>();
	/** Set on creation and on every drop: the next identify re-seeds the full
	 * input list (VU meters alone only report the currently active sources). */
	private needsSeed = true;
	private disposed = false;

	constructor(
		private readonly client: ObsClient,
		/** Called after the tracked set or a mute state changed. */
		private readonly onChange: () => void,
	) {
		client.on("InputVolumeMeters", (d) => this.onMeters(d));
		// Replayed by the client after every (re)identify — the seed trigger
		// that works without the VU-meter subscription.
		client.on("CurrentProgramSceneChanged", () => this.maybeSeed());
		client.on("InputMute", (d) => this.onMute(d));
		client.on("InputMuteStateChanged", (d) => this.onMute(d));
		client.on("InputRemoved", (d) => this.onRemoved(d));
		client.on("InputNameChanged", (d) => this.onRenamed(d));
		// OBS gone: its mute buttons can't work until it is back.
		client.on(OBS_DISCONNECTED_EVENT, () => this.reset());
	}

	/** Tracked sources in discovery order. */
	list(): AudioSource[] {
		return Array.from(this.sources, ([name, muted]) => ({ name, muted }));
	}

	/** Stop reacting (the client's listeners can't be removed; they go inert). */
	dispose(): void {
		this.disposed = true;
		this.sources.clear();
		this.queried.clear();
	}

	private reset(): void {
		this.needsSeed = true;
		this.queried.clear();
		if (!this.sources.size) return;
		this.sources.clear();
		this.onChange();
	}

	private maybeSeed(): void {
		if (!this.needsSeed || this.disposed || !this.client.identified) return;
		this.needsSeed = false;
		void this.seed();
	}

	/** Seed from OBS's full input list (one GetInputList + one mute batch). */
	private async seed(): Promise<void> {
		try {
			const res = await this.client.sendRequest({
				requestType: "GetInputList",
				requestId: randomUUID(),
				requestData: {},
			});
			const inputs = res.responseData?.inputs;
			if (!Array.isArray(inputs)) return;
			const names: string[] = [];
			for (const i of inputs) {
				const name = (i as Data | null)?.inputName;
				if (typeof name === "string") names.push(name);
			}
			await this.track(names);
		} catch {
			this.needsSeed = true; // dropped mid-seed: retry on the next identify
		}
	}

	/** Fetch the mute state of the not-yet-queried `names` in ONE op8 batch. */
	private async track(names: string[]): Promise<void> {
		const fresh = names.filter((n) => n && !this.queried.has(n));
		if (!fresh.length || this.disposed) return;
		for (const n of fresh) this.queried.add(n);
		try {
			const res = await this.client.sendBatch({
				requestId: randomUUID(),
				// requestId = index into `fresh`, to pair results back to names
				requests: fresh.map((inputName, i) => ({
					requestType: "GetInputMute",
					requestId: String(i),
					requestData: { inputName },
				})),
				haltOnFailure: false,
			});
			if (this.disposed) return;
			let changed = false;
			for (const r of res.results) {
				const name = fresh[Number(r.requestId)];
				const muted = r.responseData?.inputMuted;
				if (name !== undefined && typeof muted === "boolean" && !this.sources.has(name)) {
					this.sources.set(name, muted);
					changed = true;
				}
			}
			if (changed) this.onChange();
		} catch {
			// Dropped connection: allow a retry once the sources surface again.
			for (const n of fresh) this.queried.delete(n);
		}
	}

	/** Hot path (~20 Hz): only a not-yet-queried name costs more than a lookup. */
	private onMeters(d: Data): void {
		if (this.disposed) return;
		this.maybeSeed();
		if (!Array.isArray(d.inputs)) return;
		let unseen: string[] | undefined;
		for (const i of d.inputs) {
			const name = (i as Data | null)?.inputName;
			if (typeof name === "string" && !this.queried.has(name))
				(unseen ??= []).push(name);
		}
		if (unseen) void this.track(unseen);
	}

	private onMute(d: Data): void {
		const { inputName: name, inputMuted: muted } = d;
		if (this.disposed || typeof name !== "string" || !name || typeof muted !== "boolean")
			return;
		if (this.sources.get(name) === muted) return;
		this.sources.set(name, muted);
		this.queried.add(name);
		this.onChange();
	}

	private onRemoved(d: Data): void {
		if (this.disposed || typeof d.inputName !== "string") return;
		this.queried.delete(d.inputName);
		if (this.sources.delete(d.inputName)) this.onChange();
	}

	private onRenamed(d: Data): void {
		const { oldInputName: from, inputName: to } = d;
		if (this.disposed || typeof from !== "string" || typeof to !== "string") return;
		this.queried.delete(from);
		const muted = this.sources.get(from);
		if (muted === undefined) return;
		// Rebuild to keep the renamed source in its place in the button order.
		const entries = Array.from(this.sources, ([n, m]) => [n === from ? to : n, m] as const);
		this.sources.clear();
		for (const [n, m] of entries) this.sources.set(n, m);
		this.queried.add(to);
		this.onChange();
	}
}
