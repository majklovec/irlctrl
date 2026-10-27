/*
 * OBS scene tracker: the scene list and the live (program) scene, kept current
 * from obs-websocket events.
 * Shared by the in-process obs-controller module and the standalone
 * obs-client box — both publish `list()` / `current()` as `status.obs.scenes`
 * / `status.obs.currentScene`, which the module's `dashboardActions` factory
 * turns into one switch button per scene (the live one marked).
 *
 * No seed request: the ObsClient replays `GetSceneList` /
 * `GetCurrentProgramScene` as events after every (re)identify.
 */
import { OBS_DISCONNECTED_EVENT, type ObsClient } from "../../shared/obs/client";

type Data = Record<string, unknown>;

export class SceneTracker {
	/** Scene names in OBS's `GetSceneList` order (as the card's scene deck shows them). */
	private scenes: string[] = [];
	private live: string | null = null;
	private disposed = false;

	constructor(
		client: ObsClient,
		/** Called after the scene list changed. */
		private readonly onChange: () => void,
	) {
		client.on("SceneListChanged", (d) => this.onList(d));
		client.on("SceneCreated", (d) => this.onCreated(d));
		client.on("SceneRemoved", (d) => this.onRemoved(d));
		client.on("SceneNameChanged", (d) => this.onRenamed(d));
		client.on("CurrentProgramSceneChanged", (d) =>
			this.setLive(typeof d.sceneName === "string" ? d.sceneName : null),
		);
		client.on(OBS_DISCONNECTED_EVENT, () => {
			this.set([]);
			this.setLive(null);
		});
	}

	list(): readonly string[] {
		return this.scenes;
	}

	/** The live (program) scene, null when unknown. */
	current(): string | null {
		return this.live;
	}

	dispose(): void {
		this.disposed = true;
		this.scenes = [];
		this.live = null;
	}

	private setLive(name: string | null): void {
		if (this.disposed || name === this.live) return;
		this.live = name;
		this.onChange();
	}

	private set(next: string[]): void {
		if (this.disposed) return;
		if (
			next.length === this.scenes.length &&
			next.every((n, i) => n === this.scenes[i])
		)
			return;
		this.scenes = next;
		this.onChange();
	}

	private onList(d: Data): void {
		if (!Array.isArray(d.scenes)) return;
		const names: string[] = [];
		for (const s of d.scenes) {
			const name = (s as Data | null)?.sceneName;
			if (typeof name === "string" && name) names.push(name);
		}
		this.set(names);
	}

	private onCreated(d: Data): void {
		// Groups are scenes internally; they are not switchable program scenes.
		if (d.isGroup === true || typeof d.sceneName !== "string") return;
		if (!this.scenes.includes(d.sceneName))
			this.set([...this.scenes, d.sceneName]);
	}

	private onRemoved(d: Data): void {
		if (typeof d.sceneName === "string")
			this.set(this.scenes.filter((n) => n !== d.sceneName));
	}

	private onRenamed(d: Data): void {
		const { oldSceneName: from, sceneName: to } = d;
		if (typeof from !== "string" || typeof to !== "string") return;
		this.set(this.scenes.map((n) => (n === from ? to : n)));
		if (this.live === from) this.setLive(to);
	}
}
